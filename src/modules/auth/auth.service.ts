import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { PrismaService } from '../../common/services/prisma.service';
import { permissionsOf } from '../../common/permissions';
import { RedisService } from '../../common/services/redis.service';
import { AppSettingsService } from '../../common/services/app-settings.service';
import { normalizeSaudiPhone } from '../../common/utils/phone.util';
import { RealtimeService } from '../../common/services/realtime.service';
import { WhatsAppError, WhatsAppService } from '../../common/services/whatsapp.service';
import { NotificationsService } from '../../common/services/notifications.service';
import { revokedTokenKey } from './jwt.strategy';

// Verifying against this when the account doesn't exist keeps response timing identical to a wrong password.
const DUMMY_PASSWORD_HASH = argon2.hash(crypto.randomBytes(32).toString('hex'));

const ACCOUNT_WIDE_FAILURES_FACTOR = 10;

/** Long enough to receive a code by WhatsApp and type it, short enough that a leaked link token is soon worthless. */
const GOOGLE_LINK_TTL_SECONDS = 15 * 60;
const googleLinkKey = (linkToken: string) => `google_link:${linkToken}`;

/** A refreshed session moves the last-login time only when it is older than this, so frequent refreshes do not each write to the account. */
const LAST_LOGIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** What a verified Google ID token says about its owner. The email is kept only when Google verified it. */
interface GoogleIdentity {
  googleId: string;
  email: string | null;
}

const AUTH_USER_SELECT = {
  id: true,
  phone: true,
  email: true,
  name: true,
  role: true,
  walletBalance: true,
  branchId: true,
  branch: { select: { id: true, name: true } },
  extraPermissions: true,
  revokedPermissions: true,
  rank: { select: { id: true, name: true, permissions: true } },
} as const;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /** Caches Google's signing keys between sign-ins; the audience is passed per call, so a changed client id applies at once. */
  private readonly googleClient = new OAuth2Client();

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
    private redis: RedisService,
    private appSettings: AppSettingsService,
    private realtime: RealtimeService,
    private whatsapp: WhatsAppService,
    private notifications: NotificationsService,
  ) {}

  private hashOtp(phone: string, code: string) {
    return crypto.createHmac('sha256', this.config.getOrThrow('JWT_ACCESS_SECRET')).update(`${phone}:${code}`).digest('hex');
  }

  async sendOtp(rawPhone: string) {
    const phone = normalizeSaudiPhone(rawPhone);
    const echoCode = this.config.get('OTP_DEV_ECHO') === 'true';
    // Checked before any limit is spent, so a customer is not locked out by a connection that was never going to send.
    const whatsappReady = !echoCode && (await this.whatsapp.isOtpConfigured());
    // TEMPORARY for the client's trial: until WhatsApp is connected, the code goes to the admins' notifications.
    const codeGoesToAdmins = !echoCode && !whatsappReady && this.config.get('CLIENT_TRIAL_MODE') === 'true';
    if (!echoCode && !whatsappReady && !codeGoesToAdmins) {
      throw new ServiceUnavailableException('خدمة إرسال رمز التحقق غير مفعلة حاليًا');
    }

    const limits = await this.appSettings.numbers('otpResendCooldownSeconds', 'otpMaxSendsPerHour', 'otpTtlMinutes');
    if (!(await this.redis.setnx(`otp_cooldown:${phone}`, '1', limits.otpResendCooldownSeconds))) {
      throw new HttpException('يرجى الانتظار قليلًا قبل طلب رمز جديد', HttpStatus.TOO_MANY_REQUESTS);
    }
    if ((await this.redis.incr(`otp_sends:${phone}`, 3600)) > limits.otpMaxSendsPerHour) {
      throw new HttpException('تجاوزت عدد المحاولات المسموح، حاول لاحقًا', HttpStatus.TOO_MANY_REQUESTS);
    }

    const otpCode = crypto.randomInt(1000, 10000).toString();
    await this.redis.set(`otp:${phone}`, this.hashOtp(phone, otpCode), limits.otpTtlMinutes * 60);
    await this.redis.del(`otp_attempts:${phone}`);

    if (echoCode) {
      this.logger.log(`OTP for ${phone}: ${otpCode}`);
      return { success: true, message: 'تم إرسال رمز التحقق', devCode: otpCode };
    }

    if (codeGoesToAdmins) {
      const reached = await this.notifications.trialLoginCodeToAdmins(this.prisma, phone, otpCode, limits.otpTtlMinutes).catch(() => 0);
      if (reached === 0) {
        await this.redis.del(`otp:${phone}`);
        await this.redis.del(`otp_cooldown:${phone}`);
        throw new ServiceUnavailableException('تعذر إرسال رمز التحقق الآن، حاول بعد قليل');
      }
      return { success: true, message: 'تم إرسال رمز التحقق إلى إدارة التطبيق' };
    }

    try {
      await this.whatsapp.sendOtp(phone, otpCode);
    } catch (err) {
      // A code that never arrived must not count against the wait, or the customer could not ask again at once.
      await this.redis.del(`otp:${phone}`);
      await this.redis.del(`otp_cooldown:${phone}`);
      if (err instanceof WhatsAppError && err.kind === 'RECIPIENT') {
        throw new BadRequestException('هذا الرقم غير مسجل في واتساب، فلا يمكن إرسال رمز التحقق إليه');
      }
      this.logger.error(`WhatsApp OTP failed (${err instanceof WhatsAppError ? `${err.kind} ${err.code ?? ''}` : 'unknown'})`);
      throw new ServiceUnavailableException('تعذر إرسال رمز التحقق الآن، حاول بعد قليل');
    }
    return { success: true, message: 'تم إرسال رمز التحقق إلى واتساب' };
  }

  async verifyOtp(rawPhone: string, code: string, ip?: string, userAgent?: string) {
    const phone = normalizeSaudiPhone(rawPhone);
    await this.checkOtp(phone, code);

    let user = await this.prisma.user.findUnique({ where: { phone } });
    await this.assertCustomerMayEnter(user);
    await this.consumeOtp(phone);

    if (!user) {
      user = await this.prisma.user.create({
        data: { phone, isVerified: true },
      });
    } else if (!user.isVerified) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { isVerified: true },
      });
    }

    return this.generateAuthTokens(user.id, user.role, ip, userAgent);
  }

  /** Throws unless the code is right. It stays usable, so a refusal that follows (a blocked account) does not cost the customer their code. */
  private async checkOtp(phone: string, code: string) {
    const invalidCode = new BadRequestException('رمز التحقق غير صحيح أو منتهي الصلاحية');

    const storedHash = await this.redis.get(`otp:${phone}`);
    if (!storedHash) throw invalidCode;

    const limits = await this.appSettings.numbers('otpTtlMinutes', 'otpMaxAttempts', 'otpMaxFailuresPerDay');
    // Requesting a new code resets the per-code count, so this one must survive it or a short code can be guessed by repeating the cycle.
    const dailyFailuresKey = `otp_failures:${phone}`;
    if (Number((await this.redis.get(dailyFailuresKey)) ?? 0) >= limits.otpMaxFailuresPerDay) {
      throw new HttpException('تم إيقاف الدخول بهذا الرقم مؤقتًا بسبب كثرة المحاولات الخاطئة، حاول لاحقًا', HttpStatus.TOO_MANY_REQUESTS);
    }
    if ((await this.redis.incr(`otp_attempts:${phone}`, limits.otpTtlMinutes * 60)) > limits.otpMaxAttempts) {
      await this.redis.del(`otp:${phone}`);
      throw new HttpException('تجاوزت عدد المحاولات، اطلب رمزًا جديدًا', HttpStatus.TOO_MANY_REQUESTS);
    }

    const provided = Buffer.from(this.hashOtp(phone, code));
    const expected = Buffer.from(storedHash);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      await this.redis.incr(dailyFailuresKey, 24 * 60 * 60);
      throw invalidCode;
    }
  }

  /** A code opens one sign-in only. */
  private async consumeOtp(phone: string) {
    await this.redis.del(`otp:${phone}`);
    await this.redis.del(`otp_attempts:${phone}`);
    await this.redis.del(`otp_failures:${phone}`);
  }

  /** The account a customer may open with a phone code or Google, or a new one when registration is open. */
  private async assertCustomerMayEnter(user: { role: string; blockedAt: Date | null } | null) {
    // Staff accounts have elevated access, so a phone code alone must never be enough to open them.
    if (user && user.role !== 'PASSENGER') {
      throw new ForbiddenException('هذا الحساب يدخل عبر بوابة الموظفين بكلمة المرور');
    }
    if (user?.blockedAt) {
      throw new ForbiddenException('هذا الحساب موقوف. تواصل مع خدمة العملاء');
    }
    if (!user && !(await this.appSettings.flag('registrationEnabled'))) {
      throw new ForbiddenException('تسجيل الحسابات الجديدة متوقف مؤقتًا');
    }
  }

  // ---- Google quick sign-in ----

  /**
   * Signs in a customer whose Google account is already linked. Any other Google account gets a short-lived link token
   * instead, and proves a phone with the usual code (see linkGoogle): the phone is what identifies an account here.
   * The email on a profile is typed by the customer and never verified, so it is not used to find the account: a typo
   * would otherwise hand that account, wallet included, to whoever owns the typed address.
   */
  async googleSignIn(idToken: string, ip?: string, userAgent?: string) {
    const identity = await this.verifyGoogleToken(idToken);
    const user = await this.prisma.user.findUnique({ where: { googleId: identity.googleId } });
    if (user) {
      // An employee promoted from a customer keeps the link, and must still use their password.
      await this.assertCustomerMayEnter(user);
      return this.generateAuthTokens(user.id, user.role, ip, userAgent);
    }
    const linkToken = crypto.randomBytes(32).toString('hex');
    await this.redis.set(googleLinkKey(linkToken), JSON.stringify(identity), GOOGLE_LINK_TTL_SECONDS);
    return { needsPhone: true as const, linkToken, email: identity.email };
  }

  /** Finishes a first Google sign-in: the phone's code proves the account, and the Google account is linked to it. */
  async linkGoogle(linkToken: string, rawPhone: string, code: string, ip?: string, userAgent?: string) {
    const saved = await this.redis.get(googleLinkKey(linkToken));
    if (!saved) throw new BadRequestException('انتهت مهلة ربط حساب Google، أعد المحاولة من البداية');
    const identity = JSON.parse(saved) as GoogleIdentity;

    const phone = normalizeSaudiPhone(rawPhone);
    await this.checkOtp(phone, code);
    const user = await this.prisma.user.findUnique({ where: { phone } });
    await this.assertCustomerMayEnter(user);
    if (user?.googleId && user.googleId !== identity.googleId) {
      throw new ConflictException('هذا الرقم مرتبط بحساب Google آخر. ادخل برقم الجوال ثم تابع');
    }
    const linkedElsewhere = await this.prisma.user.findFirst({ where: { googleId: identity.googleId, ...(user && { id: { not: user.id } }) }, select: { id: true } });
    if (linkedElsewhere) throw new ConflictException('حساب Google هذا مرتبط برقم آخر. ادخل به مباشرة');

    await this.consumeOtp(phone);
    await this.redis.del(googleLinkKey(linkToken));

    // Google vouched for this address, so it fills an empty profile email, unless another account already uses it.
    const canTakeEmail = !!identity.email && !user?.email && (await this.prisma.user.count({ where: { email: identity.email } })) === 0;
    const email = canTakeEmail ? { email: identity.email } : {};
    try {
      const linked = user
        ? await this.prisma.user.update({ where: { id: user.id }, data: { googleId: identity.googleId, isVerified: true, ...email } })
        : await this.prisma.user.create({ data: { phone, googleId: identity.googleId, isVerified: true, ...email } });
      return this.generateAuthTokens(linked.id, linked.role, ip, userAgent);
    } catch (err) {
      // Two taps of the same link can race to the unique index; the second one is told what happened.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('تم ربط حساب Google بالفعل، ادخل به مباشرة');
      }
      throw err;
    }
  }

  private async verifyGoogleToken(idToken: string): Promise<GoogleIdentity> {
    const setting = await this.prisma.setting.findUnique({ where: { key: 'googleWebClientId' } });
    const audience = setting?.value.trim();
    if (!audience) throw new ServiceUnavailableException('الدخول بحساب Google غير مفعّل حاليًا');
    let payload: TokenPayload | undefined;
    try {
      // Checks Google's signature, the issuer, the expiry, and that the token was issued for this app and no other.
      const ticket = await this.googleClient.verifyIdToken({ idToken, audience });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedException('تعذر التحقق من حساب Google، حاول مرة أخرى');
    }
    if (!payload?.sub) throw new UnauthorizedException('تعذر التحقق من حساب Google، حاول مرة أخرى');
    // An address Google has not verified could belong to anyone, so it is not kept.
    const email = payload.email_verified === true && payload.email ? payload.email.trim().toLowerCase() : null;
    return { googleId: payload.sub, email };
  }

  async staffLogin(rawIdentifier: string, password: string, ip?: string, userAgent?: string) {
    const identifier = rawIdentifier.trim();
    const where = identifier.includes('@') ? { email: identifier.toLowerCase() } : { phone: normalizeSaudiPhone(identifier) };
    const user = await this.prisma.user.findUnique({ where, include: { driverProfile: { select: { isActive: true } } } });
    // Counted against the account, so its phone and email do not each get their own allowance of guesses.
    const subject = user?.id ?? where.email ?? where.phone;
    // Per address, so a stranger failing on purpose cannot lock the real employee out from another network.
    const lockKey = `login_failures:${subject}:${ip ?? 'unknown'}`;
    // Across all addresses, far higher, so guessing from many addresses still hits a limit.
    const accountLockKey = `login_failures_total:${subject}`;
    const { loginMaxFailures, loginLockMinutes } = await this.appSettings.numbers('loginMaxFailures', 'loginLockMinutes');
    if (
      Number((await this.redis.get(lockKey)) ?? 0) >= loginMaxFailures ||
      Number((await this.redis.get(accountLockKey)) ?? 0) >= loginMaxFailures * ACCOUNT_WIDE_FAILURES_FACTOR
    ) {
      throw new HttpException(`تم إيقاف الدخول مؤقتًا بسبب كثرة المحاولات، حاول بعد ${loginLockMinutes} ${loginLockMinutes >= 3 && loginLockMinutes <= 10 ? 'دقائق' : 'دقيقة'}`, HttpStatus.TOO_MANY_REQUESTS);
    }

    const isStaff = !!user?.passwordHash && user.role !== 'PASSENGER';
    const isValid = await argon2.verify(isStaff ? user.passwordHash : await DUMMY_PASSWORD_HASH, password);
    if (!isStaff || !isValid) {
      await this.redis.incr(lockKey, loginLockMinutes * 60);
      await this.redis.incr(accountLockKey, loginLockMinutes * 60);
      throw new UnauthorizedException('بيانات الدخول غير صحيحة');
    }
    if (user.blockedAt) {
      throw new ForbiddenException('هذا الحساب موقوف. راجع الإدارة');
    }
    if (user.driverProfile?.isActive === false) {
      throw new ForbiddenException('هذا الحساب موقوف، راجع الإدارة');
    }

    await this.redis.del(lockKey);
    await this.redis.del(accountLockKey);
    return this.generateAuthTokens(user.id, user.role, ip, userAgent);
  }

  async refresh(refreshToken: string, ip?: string, userAgent?: string) {
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!storedToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (storedToken.user.blockedAt) {
      throw new UnauthorizedException('Account blocked');
    }

    if (new Date() > storedToken.expiresAt && !storedToken.revoked) {
      throw new UnauthorizedException('Refresh token expired');
    }

    // The condition is what lets only one of two simultaneous requests win; the loser is a reused token like any other.
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: storedToken.id, revoked: false },
      data: { revoked: true },
    });
    if (claimed.count === 0) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: storedToken.userId },
        data: { revoked: true },
      });
      throw new ForbiddenException('Refresh token reuse detected. All sessions revoked.');
    }

    return this.generateAuthTokens(storedToken.userId, storedToken.user.role, ip, userAgent, true);
  }

  /** accessTokenExp is the token's own expiry in seconds, so it stays refused for exactly as long as it could still be used. */
  async logout(userId: string, refreshToken?: string, accessTokenJti?: string, accessTokenExp?: number) {
    if (refreshToken) {
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash, userId },
        data: { revoked: true },
      });
    }
    if (accessTokenJti) {
      // Refused for exactly as long as the token itself could still be used, whatever lifetime is configured.
      const ttl = accessTokenExp ? Math.max(1, accessTokenExp - Math.floor(Date.now() / 1000)) : 24 * 60 * 60;
      await this.redis.set(`bl_jti:${accessTokenJti}`, 'revoked', ttl);
      // A live connection opened with this token would otherwise keep receiving until the token ran out.
      this.realtime.disconnectSession(accessTokenJti);
    }
    return { success: true, message: 'Logged out successfully' };
  }

  async getMe(userId: string) {
    const { rank, extraPermissions, revokedPermissions, ...user } = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: AUTH_USER_SELECT });
    return { ...user, rank: rank && { id: rank.id, name: rank.name }, permissions: permissionsOf({ role: user.role, rank, extraPermissions, revokedPermissions }) };
  }

  /** refreshed marks a session refresh rather than a sign-in: it moves the last-login time only when that is a few minutes old. */
  private async generateAuthTokens(userId: string, role: string, ip?: string, userAgent?: string, refreshed = false) {
    const jti = crypto.randomUUID();
    const accessToken = this.jwtService.sign(
      { sub: userId, role, jti },
      {
        secret: this.config.getOrThrow('JWT_ACCESS_SECRET'),
        expiresIn: this.config.get('JWT_ACCESS_EXPIRES_IN', '15m'),
      },
    );

    const opaqueRefreshToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(opaqueRefreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await this.prisma.refreshToken.create({
      data: {
        tokenHash,
        userId,
        ip,
        userAgent,
        expiresAt,
      },
    });

    const now = new Date();
    await this.prisma.user.updateMany({
      where: { id: userId, ...(refreshed && { OR: [{ lastLoginAt: null }, { lastLoginAt: { lt: new Date(now.getTime() - LAST_LOGIN_REFRESH_INTERVAL_MS) } }] }) },
      data: { lastLoginAt: now },
    });

    const user = await this.getMe(userId);

    return {
      accessToken,
      refreshToken: opaqueRefreshToken,
      user,
    };
  }
}
