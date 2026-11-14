import { Controller, Get, Header, Post, Put, Delete, Param, Body, Query, Req, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Gender, IdType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsString, IsNotEmpty, IsNumber, IsOptional, Length, Matches, Max, MaxLength, Min, NotEquals, ValidateIf } from 'class-validator';
import { MAX_PHOTO_BYTES, UploadedPhoto, UsersService } from './users.service';
import { StaffAchievementsService } from './staff-achievements.service';
import { CustomerMergeService, DuplicateReason } from './customer-merge.service';
import { RequirePermission, SkipAudit } from '../../common/decorators/auth.decorators';
import { MESSAGE_LANGUAGES } from '../../common/notification-catalog';
import { ALL_PERMISSIONS } from '../../common/permissions';
import { CITY_MAX_LENGTH, CUSTOMER_CITIES, GENDERS, NATIONALITIES, NATIVE_LANGUAGE_KEYS, NATIVE_LANGUAGES, OTHER_CITY } from '../../common/profile-options';
import { ID_TYPES, ID_TYPE_LABELS } from '../../common/utils/identity.util';

/** Shown in place, never downloaded; only ever an image, since the bytes were checked on upload. */
const inlinePhoto = (photo: { data: Uint8Array; mimeType: string; size: number }) =>
  new StreamableFile(Buffer.from(photo.data), { type: photo.mimeType, length: photo.size, disposition: 'inline' });

/** The same fields whoever edits them; null clears one. */
class ProfileDetailsDto {
  @ValidateIf((dto) => dto.nationality !== null && dto.nationality !== undefined)
  @IsString()
  @MaxLength(60)
  nationality?: string | null;

  // A city from the list, or one typed after choosing "أخرى".
  @ValidateIf((dto) => dto.city !== null && dto.city !== undefined && dto.city !== '')
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(2, CITY_MAX_LENGTH, { message: 'اكتب اسم المدينة' })
  @NotEquals(OTHER_CITY, { message: 'اكتب اسم المدينة' })
  city?: string | null;

  @ValidateIf((dto) => dto.nativeLanguage !== null && dto.nativeLanguage !== undefined)
  @IsIn(NATIVE_LANGUAGE_KEYS, { message: 'اختر اللغة الأم من القائمة' })
  nativeLanguage?: string | null;

  @ValidateIf((dto) => dto.gender !== null && dto.gender !== undefined)
  @IsIn(GENDERS, { message: 'اختر الجنس من القائمة' })
  gender?: Gender | null;

  // National ID, iqama or passport; the type decides which numbers are valid, checked in the service.
  @ValidateIf((dto) => dto.idType !== null && dto.idType !== undefined)
  @IsIn(ID_TYPES, { message: 'اختر نوع الهوية: هوية وطنية أو إقامة أو جواز سفر' })
  idType?: IdType | null;

  @ValidateIf((dto) => dto.idNumber !== null && dto.idNumber !== undefined)
  @IsString()
  @MaxLength(30)
  idNumber?: string | null;
}

class UpdateProfileDto extends ProfileDetailsDto {
  @IsString()
  @Length(2, 100)
  name: string;

  @ValidateIf((dto) => dto.email !== null && dto.email !== undefined)
  @IsEmail({}, { message: 'البريد الإلكتروني غير صحيح' })
  @MaxLength(254)
  email?: string | null;
}

class CreateStaffDto {
  @IsString()
  @Length(2, 100)
  name: string;

  @IsOptional()
  @IsIn(GENDERS, { message: 'اختر الجنس من القائمة' })
  gender?: Gender;

  @IsOptional()
  @IsIn(ID_TYPES, { message: 'اختر نوع الهوية: هوية وطنية أو إقامة أو جواز سفر' })
  idType?: IdType;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  idNumber?: string;


  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة تاريخ إصدار الهوية غير صحيحة' })
  idIssueDate?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة تاريخ انتهاء الهوية غير صحيحة' })
  idExpiryDate?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة تاريخ الميلاد غير صحيحة' })
  birthDate?: string;

  /** Opens the employment file with the account. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة تاريخ التعيين غير صحيحة' })
  hireDate?: string;

  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsOptional()
  @IsEmail({}, { message: 'البريد الإلكتروني غير صحيح' })
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @Matches(/^\d{5,20}$/, { message: 'رقم الهوية أو الإقامة أرقام فقط، من 5 إلى 20 رقمًا' })
  iqamaNumber?: string;

  @IsOptional()
  @IsString()
  @Length(2, 60)
  nationality?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة انتهاء الرخصة غير صحيحة' })
  licenseExpiry?: string;

  @IsString()
  @IsNotEmpty()
  rankId: string;

  @IsString()
  @Length(10, 200, { message: 'كلمة المرور يجب ألا تقل عن 10 أحرف' })
  password: string;

  @IsOptional()
  @IsString()
  branchId?: string;
}

class UpdateAccessDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  rankId?: string;

  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS, { each: true })
  extraPermissions: string[];

  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS, { each: true })
  revokedPermissions: string[];
}

class UpdateUserAdminDto extends ProfileDetailsDto {
  @IsOptional()
  @IsString()
  @Length(2, 100)
  name?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @ValidateIf((dto) => dto.email !== null && dto.email !== undefined)
  @IsEmail({}, { message: 'البريد الإلكتروني غير صحيح' })
  @MaxLength(254)
  email?: string | null;

  // null turns an employee back into a regular customer.
  @ValidateIf((dto) => dto.rankId !== null && dto.rankId !== undefined)
  @IsString()
  rankId?: string | null;

  // Decides whose drawer an employee can reach, so only employee managers may change it.
  @ValidateIf((dto) => dto.branchId !== null && dto.branchId !== undefined)
  @IsString()
  branchId?: string | null;

  @IsOptional()
  @IsString()
  @Length(10, 200, { message: 'كلمة المرور يجب ألا تقل عن 10 أحرف' })
  password?: string;

  @IsOptional()
  @IsIn(MESSAGE_LANGUAGES)
  messageLanguage?: string;

  @ValidateIf((dto) => dto.idIssueDate !== null && dto.idIssueDate !== undefined)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة تاريخ إصدار الهوية غير صحيحة' })
  idIssueDate?: string | null;

  @ValidateIf((dto) => dto.idExpiryDate !== null && dto.idExpiryDate !== undefined)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة تاريخ انتهاء الهوية غير صحيحة' })
  idExpiryDate?: string | null;

  @ValidateIf((dto) => dto.birthDate !== null && dto.birthDate !== undefined)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة تاريخ الميلاد غير صحيحة' })
  birthDate?: string | null;
}

class UpdateCityDto {
  // A city from the list, or one the customer typed after choosing "أخرى".
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(2, CITY_MAX_LENGTH, { message: 'اختر المدينة من القائمة أو اكتب اسمها' })
  @NotEquals(OTHER_CITY, { message: 'اكتب اسم المدينة' })
  city: string;
}

class UpdateMessagingDto {
  @IsOptional()
  @IsIn(MESSAGE_LANGUAGES)
  messageLanguage?: string;

  @IsOptional()
  @IsBoolean()
  acceptsOffers?: boolean;

  /** Reminders before the miqat and the gathering point; null minutes follow the trip's settings. */
  @IsOptional()
  @IsBoolean()
  tripAlertsEnabled?: boolean;

  @ValidateIf((dto) => dto.alertLeadMinutes !== null)
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  alertLeadMinutes?: number | null;

  @ValidateIf((dto) => dto.alertRepeatMinutes !== null)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(720)
  alertRepeatMinutes?: number | null;
}

class PromoteUserDto {
  @IsString()
  @IsNotEmpty()
  rankId: string;

  @IsOptional()
  @IsIn(GENDERS, { message: 'اختر الجنس من القائمة' })
  gender?: Gender;

  @IsOptional()
  @IsIn(ID_TYPES, { message: 'اختر نوع الهوية: هوية وطنية أو إقامة أو جواز سفر' })
  idType?: IdType;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  idNumber?: string;


  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة تاريخ إصدار الهوية غير صحيحة' })
  idIssueDate?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة تاريخ انتهاء الهوية غير صحيحة' })
  idExpiryDate?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة تاريخ الميلاد غير صحيحة' })
  birthDate?: string;

  /** Opens the employment file with the account. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة تاريخ التعيين غير صحيحة' })
  hireDate?: string;

  @IsOptional()
  @IsEmail({}, { message: 'البريد الإلكتروني غير صحيح' })
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsString()
  @Length(10, 200, { message: 'كلمة المرور يجب ألا تقل عن 10 أحرف' })
  password?: string;

  @IsOptional()
  @Matches(/^\d{5,20}$/, { message: 'رقم الهوية أو الإقامة أرقام فقط، من 5 إلى 20 رقمًا' })
  iqamaNumber?: string;

  @IsOptional()
  @IsString()
  @Length(2, 60)
  nationality?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة انتهاء الرخصة غير صحيحة' })
  licenseExpiry?: string;
}

class CandidatesQuery {
  @IsString()
  @Length(2, 100)
  search: string;
}

class AdjustWalletDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(-100000)
  @Max(100000)
  amount: number;

  @IsString()
  @Length(3, 300)
  description: string;

  /** On a credit: true makes it transport-only, like a compensation; false (default) is ordinary money for transport and housing. */
  @IsOptional()
  @IsBoolean()
  transportOnly?: boolean;
}

class ReferralCodeDto {
  @IsString()
  @Length(4, 20)
  code: string;
}

class BlockUserDto {
  @IsBoolean()
  blocked: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

class PromoCreditDto {
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'أدخل مبلغًا صحيحًا' })
  @Min(1, { message: 'أقل رصيد ترويجي 1 ر.س' })
  @Max(100000)
  amount: number;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'اختر تاريخ انتهاء الصلاحية' })
  expiresOn: string;

  @IsString()
  @Length(3, 200, { message: 'اكتب سبب الإضافة' })
  reason: string;
}

class ListWalletsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  search?: string;

  @IsOptional()
  @IsIn(['holders', 'promo', 'all'])
  filter?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

class AchievementsQuery {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة التاريخ غير صحيحة' })
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة التاريخ غير صحيحة' })
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

class DuplicatesQuery {
  @IsOptional()
  @IsIn(['idNumber', 'phone', 'name'])
  reason?: DuplicateReason;
}

class MergeCustomerDto {
  /** The account that goes away; everything it holds moves to the customer in the address. */
  @IsString()
  @IsNotEmpty({ message: 'اختر الحساب المكرر' })
  duplicateId: string;
}

class ListUsersQuery {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(['active', 'blocked'])
  status?: string;

  /** A saved city, or "none" for customers who have not chosen one. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  city?: string;

  /** A saved nationality, or "none" for customers who have not given one. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  nationality?: string;

  @IsOptional()
  @IsIn(['MALE', 'FEMALE', 'none'])
  gender?: string;

  @IsOptional()
  @IsIn(['newest', 'bookings', 'wallet'])
  sort?: string;

  @IsOptional()
  @IsString()
  jobId?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

@ApiTags('Users')
@Controller('users')
@ApiBearerAuth()
export class UsersController {
  constructor(
    private usersService: UsersService,
    private achievements: StaffAchievementsService,
    private merging: CustomerMergeService,
  ) {}

  @Get('profile')
  @ApiOperation({ summary: 'Get current user profile' })
  async getProfile(@Req() req) {
    return this.usersService.getProfile(req.user.userId);
  }

  @Put('profile')
  @ApiOperation({ summary: 'Update the name, email, nationality, native language and gender of the current user' })
  async updateProfile(@Req() req, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(req.user.userId, dto);
  }

  @Get('profile/photo')
  @Header('Cache-Control', 'private, max-age=86400')
  @ApiOperation({ summary: 'My photo; the app adds photoUpdatedAt to the address so a new one is not served from cache' })
  async getMyPhoto(@Req() req) {
    return inlinePhoto(await this.usersService.getPhoto(req.user.userId));
  }

  @Put('profile/photo')
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_PHOTO_BYTES } }))
  @ApiOperation({ summary: 'Set or replace my photo (multipart field "photo": JPG, PNG or WEBP)' })
  async setMyPhoto(@Req() req, @UploadedFile() file?: UploadedPhoto) {
    return this.usersService.setPhoto(req.user.userId, file);
  }

  @Delete('profile/photo')
  @ApiOperation({ summary: 'Remove my photo' })
  async removeMyPhoto(@Req() req) {
    return this.usersService.removePhoto(req.user.userId);
  }

  @Get('profile/options')
  @ApiOperation({ summary: 'The nationalities and native languages a profile can choose from' })
  getProfileOptions() {
    return { nationalities: NATIONALITIES, cities: CUSTOMER_CITIES, nativeLanguages: NATIVE_LANGUAGES, idTypes: ID_TYPES.map((key) => ({ key, label: ID_TYPE_LABELS[key] })) };
  }

  @Put('profile/city')
  @ApiOperation({ summary: 'The city the customer lives in, chosen when the app first opens' })
  async updateCity(@Req() req, @Body() dto: UpdateCityDto) {
    return this.usersService.updateCity(req.user.userId, dto.city);
  }

  @Put('profile/messaging')
  @ApiOperation({ summary: "The customer's alert language and whether they accept offers" })
  async updateMessaging(@Req() req, @Body() dto: UpdateMessagingDto) {
    return this.usersService.updateMessaging(req.user.userId, dto);
  }

  @Get('profile/wallet-transactions')
  @ApiOperation({ summary: 'Wallet history of the current user' })
  async getWalletTransactions(@Req() req) {
    return this.usersService.getWalletTransactions(req.user.userId);
  }

  @Get('profile/wallet-transactions/:id')
  @ApiOperation({ summary: 'One wallet transaction of the current user' })
  async getWalletTransaction(@Req() req, @Param('id') id: string) {
    return this.usersService.getWalletTransaction(req.user.userId, id);
  }

  @Get('profile/loyalty')
  @ApiOperation({ summary: 'Loyalty balance and history of the current user' })
  async getLoyalty(@Req() req) {
    return this.usersService.getLoyalty(req.user.userId);
  }

  @Post('profile/loyalty/referral')
  @ApiOperation({ summary: 'Enter a friend referral code before the first booking' })
  async applyReferralCode(@Req() req, @Body() dto: ReferralCodeDto) {
    return this.usersService.applyReferralCode(req.user.userId, dto.code);
  }

  @Get()
  @RequirePermission('customers.view')
  @ApiOperation({ summary: 'List customers; without customers.list only an exact search, counted and logged' })
  async getAllUsers(@Req() req, @Query() query: ListUsersQuery) {
    return this.usersService.getCustomers(req.user, query, req.ip);
  }

  @Get('wallets')
  @RequirePermission('customers.list')
  @ApiOperation({ summary: 'Wallet balances, promotional credit and their totals' })
  async getWallets(@Query() query: ListWalletsQuery) {
    return this.usersService.getWallets(query.search, query.filter, query.page, query.limit);
  }

  @Get('employees')
  @RequirePermission('employees.view')
  @ApiOperation({ summary: 'List employees with their ranks' })
  async getEmployees(@Query() query: ListUsersQuery) {
    return this.usersService.getEmployees(query.search, query.page, query.limit, query.jobId, query.branchId);
  }

  @Get('employees/achievements')
  @RequirePermission('employees.view')
  @ApiOperation({ summary: 'Each employee with the orders, packages, cancellations and problems they handled in a period' })
  async getAchievements(@Query() query: AchievementsQuery) {
    return this.achievements.leaderboard(query, query.search?.trim() || undefined);
  }

  @Get('employees/:id/achievements')
  @RequirePermission('employees.view')
  @ApiOperation({ summary: "One employee's figures and the record of what they did, newest first" })
  async getEmployeeAchievements(@Param('id') id: string, @Query() query: AchievementsQuery) {
    return this.achievements.forEmployee(id, query);
  }

  @Get('crew')
  @RequirePermission('trips.manage')
  @ApiOperation({ summary: 'Drivers and supervisors who can be assigned to a trip' })
  async getCrew() {
    return this.usersService.getCrew();
  }

  @Get('candidates')
  @RequirePermission('employees.manage')
  @ApiOperation({ summary: 'Find registered people by name, email or phone to bring on as employees' })
  async getCandidates(@Query() query: CandidatesQuery) {
    return this.usersService.getCandidates(query.search);
  }

  @Get('duplicates')
  @RequirePermission('customers.manage')
  @ApiOperation({ summary: 'Groups of customer accounts that look like one person: same ID number, same mobile or same name' })
  async getDuplicateGroups(@Query() query: DuplicatesQuery) {
    return this.merging.duplicateGroups(query.reason);
  }

  @Post()
  @RequirePermission('employees.manage')
  @ApiOperation({ summary: 'Create an employee account with a rank' })
  async createStaff(@Req() req, @Body() dto: CreateStaffDto) {
    return this.usersService.createStaffUser(req.user, dto);
  }

  @Post(':id/promote')
  @RequirePermission('employees.manage')
  @ApiOperation({ summary: 'Give a registered person a rank, making them an employee' })
  async promote(@Req() req, @Param('id') id: string, @Body() dto: PromoteUserDto) {
    return this.usersService.promoteToEmployee(req.user, id, dto);
  }

  @Get(':id')
  @RequirePermission('customers.view', 'employees.view')
  @ApiOperation({ summary: 'Get full user details with bookings and wallet history' })
  async getUserDetails(@Req() req, @Param('id') id: string) {
    return this.usersService.getUserDetails(req.user, id);
  }

  @Get(':id/duplicates')
  @RequirePermission('customers.manage')
  @ApiOperation({ summary: 'Customer accounts that may be the same person as this one' })
  async getDuplicatesOf(@Param('id') id: string) {
    return this.merging.duplicatesOf(id);
  }

  // The merge writes its own audit row in its transaction, with what moved, so the interceptor does not add a second.
  @Post(':id/merge')
  @SkipAudit()
  @RequirePermission('customers.manage')
  @ApiOperation({ summary: 'Merge a duplicate customer into this one: everything moves here and the duplicate is blocked' })
  async mergeCustomer(@Req() req, @Param('id') id: string, @Body() dto: MergeCustomerDto) {
    return this.merging.merge(req.user, id, dto.duplicateId, { ip: req.ip, userAgent: req.headers['user-agent'] });
  }

  @Get(':id/complaints')
  @RequirePermission('complaints.view')
  @ApiOperation({ summary: "A customer's complaints from the app and hotel complaints on their bookings" })
  async getUserComplaints(@Param('id') id: string) {
    return this.merging.complaintsOf(id);
  }

  @Get(':id/photo')
  @RequirePermission('customers.view', 'employees.view')
  @Header('Cache-Control', 'private, max-age=86400')
  @ApiOperation({ summary: "A customer's photo" })
  async getUserPhoto(@Req() req, @Param('id') id: string) {
    await this.usersService.assertCustomerPhotoAccess(req.user, id, false);
    return inlinePhoto(await this.usersService.getPhoto(id));
  }

  @Put(':id/photo')
  @RequirePermission('customers.manage')
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_PHOTO_BYTES } }))
  @ApiOperation({ summary: "Set or replace a customer's photo (multipart field \"photo\")" })
  async setUserPhoto(@Req() req, @Param('id') id: string, @UploadedFile() file?: UploadedPhoto) {
    await this.usersService.assertCustomerPhotoAccess(req.user, id, true);
    return this.usersService.setPhoto(id, file);
  }

  @Delete(':id/photo')
  @RequirePermission('customers.manage')
  @ApiOperation({ summary: "Remove a customer's photo" })
  async removeUserPhoto(@Req() req, @Param('id') id: string) {
    await this.usersService.assertCustomerPhotoAccess(req.user, id, true);
    return this.usersService.removePhoto(id);
  }

  @Put(':id')
  @RequirePermission('customers.manage', 'employees.manage')
  @ApiOperation({ summary: 'Update a customer or employee' })
  async updateUserAdmin(@Req() req, @Param('id') id: string, @Body() dto: UpdateUserAdminDto) {
    return this.usersService.updateUserAdmin(req.user, id, dto);
  }

  @Put(':id/access')
  @RequirePermission('employees.manage')
  @ApiOperation({ summary: "Change an employee's rank and personal permission adjustments" })
  async updateAccess(@Req() req, @Param('id') id: string, @Body() dto: UpdateAccessDto) {
    return this.usersService.updateAccess(req.user, id, dto);
  }

  @Put(':id/wallet')
  @RequirePermission('wallet.adjust')
  @ApiOperation({ summary: 'Adjust user wallet balance' })
  async adjustWalletBalance(@Req() req, @Param('id') id: string, @Body() dto: AdjustWalletDto) {
    return this.usersService.adjustWalletBalance(req.user, id, dto.amount, dto.description, dto.transportOnly);
  }

  @Post(':id/wallet/promo')
  @RequirePermission('wallet.adjust')
  @ApiOperation({ summary: 'Add promotional credit that expires and is only spendable on bookings' })
  async grantPromoCredit(@Req() req, @Param('id') id: string, @Body() dto: PromoCreditDto) {
    return this.usersService.grantPromoCredit(req.user, id, dto.amount, dto.expiresOn, dto.reason);
  }

  @Put(':id/block')
  @RequirePermission('customers.block', 'employees.manage')
  @ApiOperation({ summary: 'Block or unblock an account; open sessions end at once' })
  async setBlocked(@Req() req, @Param('id') id: string, @Body() dto: BlockUserDto) {
    return this.usersService.setBlocked(req.user, id, dto.blocked, dto.reason);
  }

  @Put(':id/wallet/reset')
  @RequirePermission('wallet.adjust')
  @ApiOperation({ summary: 'Zero out / reset user wallet balance' })
  async resetWalletBalance(@Req() req, @Param('id') id: string) {
    return this.usersService.resetWalletBalance(req.user, id);
  }

  @Delete(':id')
  @RequirePermission('customers.manage', 'employees.manage')
  @ApiOperation({ summary: 'Delete a customer or employee' })
  async deleteUser(@Req() req, @Param('id') id: string) {
    return this.usersService.deleteUser(req.user, id);
  }
}
