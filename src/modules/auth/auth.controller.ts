import { Controller, Post, Body, Req, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, IsNotEmpty, IsOptional, Matches, MaxLength, IsUUID, IsBoolean, Length } from 'class-validator';
import { AuthService } from './auth.service';
import { Public } from '../../common/decorators/auth.decorators';

class SendOtpDto {
  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsOptional()
  @IsString()
  channel?: string;
}

class VerifyOtpDto {
  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @Matches(/^\d{4}$/, { message: 'رمز التحقق يجب أن يكون 4 أرقام' })
  code: string;
}

class StaffLoginDto {
  // Holds a phone number or an email; the name stays so app versions already installed keep working.
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  phone: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  password: string;
}

class PanelLoginDto extends StaffLoginDto {
  @IsOptional()
  @IsUUID('4', { message: 'الفرع المختار غير صحيح' })
  branchId?: string;

  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/)
  deviceToken?: string;
}

class PanelVerifyDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/, { message: 'انتهت مهلة التحقق، سجّل الدخول من جديد' })
  challengeToken: string;

  @IsString()
  @Matches(/^\d{4}$/, { message: 'رمز التحقق يجب أن يكون 4 أرقام' })
  code: string;

  @IsOptional()
  @IsBoolean()
  rememberDevice?: boolean;
}

class PanelResendDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/, { message: 'انتهت مهلة التحقق، سجّل الدخول من جديد' })
  challengeToken: string;
}

class ForgotPasswordDto {
  @IsString()
  @IsNotEmpty()
  phone: string;
}

class ResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @Matches(/^\d{4}$/, { message: 'رمز التحقق يجب أن يكون 4 أرقام' })
  code: string;

  // The same rule as when an admin sets an employee's password.
  @IsString()
  @Length(10, 200, { message: 'كلمة المرور يجب ألا تقل عن 10 أحرف' })
  newPassword: string;
}

class GoogleSignInDto {
  // Google's ID tokens are signed JWTs of about a kilobyte; the ceiling only stops junk.
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  idToken: string;
}

class GoogleLinkDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/, { message: 'انتهت مهلة ربط حساب Google، أعد المحاولة من البداية' })
  linkToken: string;

  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @Matches(/^\d{4}$/, { message: 'رمز التحقق يجب أن يكون 4 أرقام' })
  code: string;
}

class RefreshTokenDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

class LogoutDto {
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('send-otp')
  @ApiOperation({ summary: 'Send OTP via WhatsApp' })
  async sendOtp(@Body() dto: SendOtpDto) {
    return this.authService.sendOtp(dto.phone);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('verify-otp')
  @ApiOperation({ summary: 'Verify OTP and return JWT access token + hashed refresh token' })
  async verifyOtp(@Body() dto: VerifyOtpDto, @Req() req) {
    const ip = req.ip;
    const userAgent = req.headers['user-agent'];
    return this.authService.verifyOtp(dto.phone, dto.code, ip, userAgent);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('google')
  @ApiOperation({ summary: 'Sign in with a Google ID token; an unlinked Google account gets a link token and must verify a phone' })
  async googleSignIn(@Body() dto: GoogleSignInDto, @Req() req) {
    return this.authService.googleSignIn(dto.idToken, req.ip, req.headers['user-agent']);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('google/link')
  @ApiOperation({ summary: "Verify the phone's code and link the Google account from the link token to that phone's account" })
  async linkGoogle(@Body() dto: GoogleLinkDto, @Req() req) {
    return this.authService.linkGoogle(dto.linkToken, dto.phone, dto.code, req.ip, req.headers['user-agent']);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @ApiOperation({ summary: 'Staff, driver and admin login with phone or email and password' })
  async staffLogin(@Body() dto: StaffLoginDto, @Req() req) {
    const ip = req.ip;
    const userAgent = req.headers['user-agent'];
    return this.authService.staffLogin(dto.phone, dto.password, ip, userAgent);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('login-branches')
  @ApiOperation({ summary: 'Active branches for the panel sign-in form' })
  async loginBranches() {
    return this.authService.loginBranches();
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('panel/login')
  @ApiOperation({ summary: 'Panel sign-in: password and branch, then a WhatsApp code on a device not remembered' })
  async panelLogin(@Body() dto: PanelLoginDto, @Req() req) {
    return this.authService.panelLogin(dto.phone, dto.password, { branchId: dto.branchId, deviceToken: dto.deviceToken }, req.ip, req.headers['user-agent']);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('panel/verify')
  @ApiOperation({ summary: "Second step of the panel sign-in: the WhatsApp code, optionally remembering this device" })
  async verifyPanelLogin(@Body() dto: PanelVerifyDto, @Req() req) {
    return this.authService.verifyPanelLogin(dto.challengeToken, dto.code, dto.rememberDevice === true, req.ip, req.headers['user-agent']);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('panel/resend')
  @ApiOperation({ summary: 'Send the panel sign-in code again' })
  async resendPanelCode(@Body() dto: PanelResendDto) {
    return this.authService.resendPanelCode(dto.challengeToken);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('password/forgot')
  @ApiOperation({ summary: "Send a WhatsApp code to reset a staff member's password" })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotStaffPassword(dto.phone);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('password/reset')
  @ApiOperation({ summary: 'Set a new staff password with the WhatsApp code' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetStaffPassword(dto.phone, dto.code, dto.newPassword);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @ApiOperation({ summary: 'Rotate refresh token and issue new access token' })
  async refresh(@Body() dto: RefreshTokenDto, @Req() req) {
    const ip = req.ip;
    const userAgent = req.headers['user-agent'];
    return this.authService.refresh(dto.refreshToken, ip, userAgent);
  }

  @Post('logout')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke refresh token and denylist access token' })
  async logout(@Body() dto: LogoutDto, @Req() req) {
    return this.authService.logout(req.user.userId, dto.refreshToken, req.user.jti, req.user.exp);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current authenticated user profile' })
  async getMe(@Req() req) {
    return this.authService.getMe(req.user.userId);
  }
}
