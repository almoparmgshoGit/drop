import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ContractType, EmploymentStatus, Prisma, SalaryPaymentMethod } from '@prisma/client';
import { AdjustmentsService } from './adjustments.service';
import { AdvancesService } from './advances.service';
import { DocumentsService } from './documents.service';
import { HrActor, HrCoreService } from './hr-core.service';
import { addDays, fromDbDate, halalas, monthOf, normalizeIban, parseDay, riyals, toDbDate, today, wageOf, wageTotal } from './hr.util';
import { LeavesService } from './leaves.service';
import { PayrollService } from './payroll.service';
import { SettlementsService } from './settlements.service';

export interface ProfileInput {
  hireDate: string;
  contractType?: ContractType;
  contractEndDate?: string | null;
  probationEndDate?: string | null;
  paymentMethod?: SalaryPaymentMethod;
  bankName?: string | null;
  iban?: string | null;
  gosiRegistered?: boolean;
}

export interface SalaryInput {
  effectiveFrom: string;
  basic: number;
  housing?: number;
  transport?: number;
  other?: number;
  note?: string;
}

const profileOut = (profile: Prisma.EmployeeProfileGetPayload<object> | null) =>
  profile && {
    ...profile,
    hireDate: fromDbDate(profile.hireDate),
    contractEndDate: profile.contractEndDate && fromDbDate(profile.contractEndDate),
    probationEndDate: profile.probationEndDate && fromDbDate(profile.probationEndDate),
    terminationDate: profile.terminationDate && fromDbDate(profile.terminationDate),
  };

const salaryOut = (row: Prisma.SalaryStructureGetPayload<object>) => {
  const wage = wageOf(row);
  return { ...row, effectiveFrom: fromDbDate(row.effectiveFrom), basic: riyals(wage.basic), housing: riyals(wage.housing), transport: riyals(wage.transport), other: riyals(wage.other), total: riyals(wageTotal(wage)) };
};

@Injectable()
export class EmployeeFilesService {
  constructor(
    private core: HrCoreService,
    private leaves: LeavesService,
    private advances: AdvancesService,
    private adjustments: AdjustmentsService,
    private payroll: PayrollService,
    private settlements: SettlementsService,
    private documents: DocumentsService,
  ) {}

  private get prisma() {
    return this.core.db;
  }

  // ---------------------------------------------------------------- list

  async list(actor: HrActor, query: { search?: string; branchId?: string; status?: string; withoutFile?: boolean }) {
    const showSalary = this.core.can(actor, 'hr.salaries');
    const where: Prisma.UserWhereInput = { role: { not: 'PASSENGER' }, ...(await this.core.scopeWhere(actor)) };
    if (query.branchId) where.branchId = query.branchId === 'none' ? null : query.branchId;
    if (query.withoutFile) where.employeeProfile = { is: null };
    else if (query.status) where.employeeProfile = { is: { status: query.status as EmploymentStatus } };
    if (query.search?.trim()) {
      const term = query.search.trim();
      const number = Number(term);
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { phone: { contains: /^0\d+$/.test(term) ? term.slice(1) : term } },
        ...(Number.isInteger(number) && number > 0 ? [{ employeeProfile: { is: { employeeNumber: number } } }] : []),
      ];
    }
    const day = toDbDate(today());
    const users = await this.prisma.user.findMany({
      where,
      orderBy: { name: 'asc' },
      take: 500,
      select: {
        id: true,
        name: true,
        phone: true,
        blockedAt: true,
        idType: true,
        idNumber: true,
        idIssueDate: true,
        birthDate: true,
        idExpiryDate: true,
        _count: { select: { documents: { where: { kind: 'PHOTO' } } } },
        branch: { select: { id: true, name: true } },
        rank: { select: { name: true, job: { select: { name: true } } } },
        employeeProfile: { include: showSalary ? { salaries: { where: { effectiveFrom: { lte: day } }, orderBy: { effectiveFrom: 'desc' }, take: 1 } } : undefined },
        leaveRequests: { where: { status: 'APPROVED', startDate: { lte: day }, endDate: { gte: day } }, select: { endDate: true, type: { select: { name: true } } }, take: 1 },
      },
    });
    return users.map(({ employeeProfile, leaveRequests, _count, idExpiryDate, ...user }) => {
      const salary = (employeeProfile as { salaries?: Prisma.SalaryStructureGetPayload<object>[] } | null)?.salaries?.[0];
      return {
        ...user,
        profile: employeeProfile && {
          employeeNumber: employeeProfile.employeeNumber,
          hireDate: fromDbDate(employeeProfile.hireDate),
          status: employeeProfile.status,
          paymentMethod: employeeProfile.paymentMethod,
          hasIban: !!employeeProfile.iban,
          contractEndDate: employeeProfile.contractEndDate && fromDbDate(employeeProfile.contractEndDate),
        },
        salaryTotal: showSalary ? (salary ? riyals(wageTotal(wageOf(salary))) : null) : undefined,
        onLeave: leaveRequests[0] ? { type: leaveRequests[0].type.name, until: fromDbDate(leaveRequests[0].endDate) } : null,
        idExpiryDate: idExpiryDate && fromDbDate(idExpiryDate),
        hasPhoto: _count.documents > 0,
        // Registered before official details were required, so HR knows whose file to complete.
        missingIdentity: !user.idType || !idExpiryDate || !user.idIssueDate || !user.birthDate,
      };
    });
  }

  /** Numbers for the top of the HR pages. */
  async overview(actor: HrActor) {
    const scope = await this.core.scopeWhere(actor);
    const day = toDbDate(today());
    const soon = toDbDate(new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10));
    const [staff, withFile, away, pendingLeaves, pendingAdvances, contractsEnding, expiring] = await Promise.all([
      this.prisma.user.count({ where: { role: { not: 'PASSENGER' }, ...scope } }),
      this.prisma.employeeProfile.count({ where: { status: { not: 'TERMINATED' }, user: scope } }),
      this.prisma.leaveRequest.count({ where: { status: 'APPROVED', startDate: { lte: day }, endDate: { gte: day }, user: scope } }),
      this.leaves.pendingCount(actor),
      this.advances.pendingCount(actor),
      this.prisma.employeeProfile.count({ where: { status: 'ACTIVE', contractEndDate: { gte: day, lte: soon }, user: scope } }),
      this.documents.expiring(actor),
    ]);
    return { staff, withFile, withoutFile: Math.max(staff - withFile, 0), away, pendingLeaves, pendingAdvances, contractsEnding, expiringDocuments: expiring.length };
  }

  // ---------------------------------------------------------------- one file

  /** Everything HR keeps on one employee, salary parts only for holders of hr.salaries. */
  async file(actor: HrActor, userId: string) {
    const user = await this.core.employee(actor, userId);
    const showSalary = this.core.can(actor, 'hr.salaries');
    const [salaries, balances, leaves, advances, adjustments, payslips, penalties, settlements, custodies, documents] = await Promise.all([
      showSalary ? this.prisma.salaryStructure.findMany({ where: { userId }, orderBy: { effectiveFrom: 'desc' } }) : Promise.resolve(null),
      user.employeeProfile ? this.leaves.balancesOf(userId) : Promise.resolve(null),
      this.leaves.list(actor, { userId }),
      this.advances.list(actor, { userId }),
      showSalary ? this.adjustments.list(actor, { userId }) : Promise.resolve(null),
      showSalary ? this.payroll.payslipsOf(userId, true) : Promise.resolve(null),
      this.prisma.staffPenalty.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, number: true, type: true, amount: true, reason: true, createdAt: true } }),
      this.settlements.list(actor).then((rows) => rows.filter((row) => (row.user as { id: string }).id === userId)),
      this.prisma.custody.findMany({ where: { recipientId: userId, status: 'OPEN' }, select: { id: true, number: true, amount: true, issuedAt: true } }),
      this.documents.list(actor, userId),
    ]);
    const current = salaries?.find((row) => fromDbDate(row.effectiveFrom) <= today());
    return {
      user: {
        ...user,
        employeeProfile: undefined,
        birthDate: user.birthDate && fromDbDate(user.birthDate),
        idExpiryDate: user.idExpiryDate && fromDbDate(user.idExpiryDate),
        idIssueDate: user.idIssueDate && fromDbDate(user.idIssueDate),
        driverProfile: user.driverProfile && { ...user.driverProfile, licenseExpiry: user.driverProfile.licenseExpiry && fromDbDate(user.driverProfile.licenseExpiry) },
        rank: user.rank && { name: user.rank.name, job: user.rank.job, tripAllowance: user.rank.tripAllowance && Number(user.rank.tripAllowance) },
      },
      documents,
      profile: profileOut(user.employeeProfile),
      showSalary,
      currentSalary: current ? salaryOut(current) : null,
      salaries: salaries?.map(salaryOut) ?? null,
      balances,
      leaves,
      advances,
      adjustments,
      payslips,
      penalties: penalties.map((row) => ({ ...row, amount: row.amount && Number(row.amount) })),
      settlements,
      openCustodies: custodies.map((row) => ({ ...row, amount: Number(row.amount) })),
    };
  }

  async saveProfile(actor: HrActor, userId: string, input: ProfileInput) {
    this.core.assertNotSelf(actor, userId, 'تعديل الملف الوظيفي');
    const user = await this.core.employee(actor, userId);
    if (user.employeeProfile?.status === 'TERMINATED') throw new ConflictException('انتهت خدمة هذا الموظف ولا يُعدّل ملفه');
    const hireDate = parseDay(input.hireDate, 'تاريخ التعيين');
    if (hireDate > today()) {
      // Hiring someone who starts next month is normal; a date years ahead is a typo.
      if (monthOf(hireDate) > monthOf(new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10))) throw new BadRequestException('تاريخ التعيين بعيد جدًا');
    }
    const contractEndDate = input.contractEndDate ? parseDay(input.contractEndDate, 'تاريخ انتهاء العقد') : null;
    const probationEndDate = input.probationEndDate ? parseDay(input.probationEndDate, 'تاريخ انتهاء التجربة') : null;
    if (input.contractType === 'FIXED_TERM' && !contractEndDate) throw new BadRequestException('حدد تاريخ انتهاء العقد محدد المدة');
    if (contractEndDate && contractEndDate <= hireDate) throw new BadRequestException('انتهاء العقد بعد تاريخ التعيين');
    if (probationEndDate && (probationEndDate <= hireDate || probationEndDate > addDays(hireDate, 180))) throw new BadRequestException('فترة التجربة لا تتجاوز 180 يومًا من التعيين');
    const iban = input.iban === undefined ? undefined : normalizeIban(input.iban);
    if ((input.paymentMethod ?? user.employeeProfile?.paymentMethod) === 'BANK' && iban === null && input.iban !== undefined) {
      throw new BadRequestException('الصرف بالتحويل يحتاج رقم آيبان، أو اختر الصرف النقدي');
    }
    const firstSalary = await this.prisma.salaryStructure.findFirst({ where: { userId }, orderBy: { effectiveFrom: 'asc' }, select: { effectiveFrom: true } });
    if (firstSalary && fromDbDate(firstSalary.effectiveFrom) < hireDate) throw new BadRequestException('يوجد راتب يسري قبل تاريخ التعيين الجديد، عدّله أولًا');

    const data = {
      hireDate: toDbDate(hireDate),
      ...(input.contractType && { contractType: input.contractType }),
      contractEndDate: contractEndDate ? toDbDate(contractEndDate) : null,
      probationEndDate: probationEndDate ? toDbDate(probationEndDate) : null,
      ...(input.paymentMethod && { paymentMethod: input.paymentMethod }),
      ...(input.bankName !== undefined && { bankName: input.bankName?.trim() || null }),
      ...(iban !== undefined && { iban }),
      ...(input.gosiRegistered !== undefined && { gosiRegistered: input.gosiRegistered }),
    };
    await this.prisma.$transaction(async (tx) => {
      if (user.employeeProfile && fromDbDate(user.employeeProfile.hireDate) !== hireDate) {
        const earliest = hireDate < fromDbDate(user.employeeProfile.hireDate) ? hireDate : fromDbDate(user.employeeProfile.hireDate);
        await this.core.assertMonthsOpen([monthOf(earliest)], tx);
      }
      await tx.employeeProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });
      await this.core.markStaleFrom(monthOf(hireDate < today() ? hireDate : today()), tx);
    });
    return this.file(actor, userId);
  }

  /** A raise or correction is a new row from its date; payrolls already approved keep what they used. */
  async addSalary(actor: HrActor, userId: string, input: SalaryInput) {
    this.core.assertNotSelf(actor, userId, 'تعديل الراتب');
    const user = await this.core.activeEmployee(actor, userId);
    const effectiveFrom = parseDay(input.effectiveFrom, 'تاريخ السريان');
    if (effectiveFrom < fromDbDate(user.employeeProfile.hireDate)) throw new BadRequestException('يسري الراتب من تاريخ التعيين أو بعده');
    const parts = { basic: halalas(input.basic), housing: halalas(input.housing), transport: halalas(input.transport), other: halalas(input.other) };
    if (parts.basic <= 0) throw new BadRequestException('حدد الراتب الأساسي');
    if ([parts.housing, parts.transport, parts.other].some((value) => value < 0)) throw new BadRequestException('البدلات لا تكون سالبة');
    await this.prisma.$transaction(async (tx) => {
      await this.core.assertMonthsOpen([monthOf(effectiveFrom)], tx);
      // A later approved month would have been paid on the old figures; it must not look as if the new ones applied.
      const later = await tx.payrollLine.findFirst({ where: { userId, run: { status: { not: 'DRAFT' }, month: { gt: monthOf(effectiveFrom) } } }, select: { run: { select: { month: true } } } });
      if (later) throw new ConflictException(`رواتب شهر ${later.run.month} معتمدة، لا يسري تعديل الراتب قبلها`);
      try {
        await tx.salaryStructure.create({
          data: { userId, effectiveFrom: toDbDate(effectiveFrom), basic: input.basic, housing: input.housing ?? 0, transport: input.transport ?? 0, other: input.other ?? 0, note: input.note?.trim() || null, createdById: actor.userId, createdByName: actor.name ?? null },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException('يوجد راتب يسري من نفس التاريخ، احذفه أولًا أو اختر تاريخًا آخر');
        throw err;
      }
      await this.core.markStaleFrom(monthOf(effectiveFrom), tx);
    });
    return this.file(actor, userId);
  }

  async removeSalary(actor: HrActor, userId: string, salaryId: string) {
    this.core.assertNotSelf(actor, userId, 'تعديل الراتب');
    await this.core.activeEmployee(actor, userId);
    const row = await this.prisma.salaryStructure.findFirst({ where: { id: salaryId, userId } });
    if (!row) throw new NotFoundException('سطر الراتب غير موجود');
    const month = monthOf(fromDbDate(row.effectiveFrom));
    await this.prisma.$transaction(async (tx) => {
      const used = await tx.payrollLine.findFirst({ where: { userId, run: { status: { not: 'DRAFT' }, month: { gte: month } } }, select: { id: true } });
      if (used) throw new ConflictException('صُرفت رواتب على هذا السطر، أضف سطرًا جديدًا بدل حذفه');
      await tx.salaryStructure.delete({ where: { id: salaryId } });
      await this.core.markStaleFrom(month, tx);
    });
    return this.file(actor, userId);
  }

  /** Suspension does not stop pay by itself; unpaid days are recorded as unpaid leave. It blocks requests until lifted. */
  async setStatus(actor: HrActor, userId: string, status: 'ACTIVE' | 'SUSPENDED', note?: string) {
    this.core.assertNotSelf(actor, userId, 'تغيير حالتك الوظيفية');
    await this.core.activeEmployee(actor, userId);
    if (status === 'SUSPENDED' && !note?.trim()) throw new BadRequestException('اكتب سبب الإيقاف');
    await this.prisma.employeeProfile.update({ where: { userId }, data: { status, statusNote: status === 'SUSPENDED' ? note!.trim() : null } });
    return this.file(actor, userId);
  }

  // ---------------------------------------------------------------- the employee's own

  async mine(userId: string) {
    const user = await this.core.self(userId);
    const salary = await this.prisma.salaryStructure.findFirst({ where: { userId, effectiveFrom: { lte: toDbDate(today()) } }, orderBy: { effectiveFrom: 'desc' } });
    const [balances, leaves, advances, adjustments, payslips, advanceLimits, types] = await Promise.all([
      user.employeeProfile ? this.leaves.balancesOf(userId) : Promise.resolve(null),
      this.leaves.mine(userId),
      this.advances.mine(userId),
      this.adjustments.mine(userId),
      this.payroll.payslipsOf(userId),
      user.employeeProfile ? this.advances.limitsFor(userId) : Promise.resolve({ available: false, reason: 'لم يُنشأ ملفك الوظيفي بعد' }),
      this.leaves.types(),
    ]);
    return {
      user: { id: user.id, name: user.name, phone: user.phone, rank: user.rank },
      profile: profileOut(user.employeeProfile) && { ...profileOut(user.employeeProfile), iban: user.employeeProfile?.iban ? `${user.employeeProfile.iban.slice(0, 4)}••••${user.employeeProfile.iban.slice(-4)}` : null },
      salary: salary ? salaryOut(salary) : null,
      balances,
      leaveTypes: types.filter((type) => !type.gender || type.gender === user.gender).map((type) => ({ id: type.id, name: type.name, kind: type.kind, requiresAttachment: type.requiresAttachment, maxDaysPerRequest: type.maxDaysPerRequest })),
      leaves,
      advances,
      advanceLimits,
      adjustments,
      payslips,
    };
  }
}

