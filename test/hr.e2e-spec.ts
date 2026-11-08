import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/common/services/prisma.service';
import { API, createStaff, createTestApp, loginStaff, nextPhone, officialDetails, resetDatabase } from './helpers';

const riyadhToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const shiftDays = (day: string, days: number) => new Date(new Date(`${day}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
const shiftYears = (day: string, years: number) => `${Number(day.slice(0, 4)) + years}${day.slice(4)}`;
const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const nextMonthOf = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 7);

describe('Human resources (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { auth: Record<string, string> };
  let worker: { auth: Record<string, string> };
  let workerId: string;
  const today = riyadhToday();
  const month = today.slice(0, 7);
  const hireDate = shiftDays(shiftYears(today, -2), -10);

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    admin = await loginStaff(app, (await createStaff(prisma, 'ADMIN')).phone);
    const staff = await createStaff(prisma, 'STAFF');
    workerId = staff.id;
    await prisma.user.update({ where: { id: workerId }, data: { nationality: 'سعودي', gender: 'MALE' } });
    worker = await loginStaff(app, staff.phone);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('official details and documents', () => {
    const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);

    it('refuses a new employee without nationality, gender and identity', async () => {
      const base = { name: 'موظف رسمي', phone: nextPhone(), rankId: 'rank-staff', password: 'a-long-enough-password' };
      await http().post(`${API}/users`).set(admin.auth).send(base).expect(400);
      // Letters in an iqama, a hire too young, an expiry before the issue, and an identity that has run out.
      await http().post(`${API}/users`).set(admin.auth).send({ ...base, ...officialDetails(), idNumber: '20AB000000' }).expect(400);
      await http().post(`${API}/users`).set(admin.auth).send({ ...base, ...officialDetails(), birthDate: today }).expect(400);
      await http().post(`${API}/users`).set(admin.auth).send({ ...base, ...officialDetails(), idIssueDate: '2025-01-01', idExpiryDate: '2024-12-31' }).expect(400);
      await http().post(`${API}/users`).set(admin.auth).send({ ...base, ...officialDetails(), idIssueDate: '2015-01-01', idExpiryDate: '2020-01-01' }).expect(400);
      // Any length within reason and any first digit is accepted.
      await http().post(`${API}/users`).set(admin.auth).send({ ...base, phone: nextPhone(), ...officialDetails(), idNumber: '3123456' }).expect(201);
      const created = await http().post(`${API}/users`).set(admin.auth).send({ ...base, phone: nextPhone(), ...officialDetails(), hireDate: today }).expect(201);
      expect(created.body.idType).toBe('IQAMA');
      expect(created.body.idExpiryDate).toContain('2030-06-30');
      expect(await prisma.employeeProfile.findUnique({ where: { userId: created.body.id } })).not.toBeNull();
    });

    it('files a photo, refusing anything but an image', async () => {
      const documents = `${API}/hr/employees/${workerId}/documents`;
      await http().post(documents).set(admin.auth).field('kind', 'PHOTO').attach('file', Buffer.from('%PDF-1.4'), 'x.pdf').expect(400);
      await http().post(documents).set(admin.auth).field('kind', 'PHOTO').attach('file', PNG, 'me.png').expect(201);
      const photo = await http().get(`${API}/hr/employees/${workerId}/photo`).set(admin.auth).expect(200);
      expect(photo.headers['content-type']).toContain('image/png');
      await http().get(`${API}/hr/me/photo`).set(worker.auth).expect(200);
    });

    it('takes the expiry from a scanned identity and lists it when it runs out soon', async () => {
      await prisma.user.update({ where: { id: workerId }, data: { idType: 'IQAMA' } });
      const soon = shiftDays(today, 20);
      await http().post(`${API}/hr/employees/${workerId}/documents`).set(admin.auth).field('kind', 'IQAMA').field('expiryDate', soon).attach('file', PNG, 'iqama.png').expect(201);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: workerId } })).idExpiryDate?.toISOString().slice(0, 10)).toBe(soon);
      const res = await http().get(`${API}/hr/employees/expiring`).set(admin.auth).expect(200);
      expect(res.body.some((row) => row.user.id === workerId && row.document === 'الإقامة')).toBe(true);
    });
  });

  describe('employment file and salary', () => {
    it('refuses a salary before the file exists', async () => {
      await http().post(`${API}/hr/employees/${workerId}/salaries`).set(admin.auth).send({ effectiveFrom: hireDate, basic: 6000 }).expect(409);
    });

    it('creates the file and checks the IBAN', async () => {
      await http().put(`${API}/hr/employees/${workerId}/profile`).set(admin.auth).send({ hireDate, paymentMethod: 'BANK', iban: 'SA0380000000608010167518' }).expect(400);
      const res = await http().put(`${API}/hr/employees/${workerId}/profile`).set(admin.auth).send({ hireDate, paymentMethod: 'BANK', iban: 'SA03 8000 0000 6080 1016 7519', bankName: 'الراجحي' }).expect(200);
      expect(res.body.profile.iban).toBe('SA0380000000608010167519');
      expect(res.body.profile.employeeNumber).toBeGreaterThan(0);
    });

    it('keeps salaries by date and refuses one before the hire date', async () => {
      await http().post(`${API}/hr/employees/${workerId}/salaries`).set(admin.auth).send({ effectiveFrom: shiftDays(hireDate, -1), basic: 6000 }).expect(400);
      const res = await http().post(`${API}/hr/employees/${workerId}/salaries`).set(admin.auth).send({ effectiveFrom: hireDate, basic: 6000, housing: 1500, transport: 500 }).expect(201);
      expect(res.body.currentSalary.total).toBe(8000);
    });

    it('lets nobody change their own file', async () => {
      const me = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
      await http().put(`${API}/hr/employees/${me.id}/profile`).set(admin.auth).send({ hireDate }).expect(403);
    });

    it('hides salaries from staff without hr.salaries', async () => {
      const viewer = await createStaff(prisma, 'STAFF');
      await prisma.user.update({ where: { id: viewer.id }, data: { extraPermissions: ['hr.view', 'hr.all_branches'] } });
      const session = await loginStaff(app, viewer.phone);
      const res = await http().get(`${API}/hr/employees/${workerId}`).set(session.auth).expect(200);
      expect(res.body.salaries).toBeNull();
      expect(res.body.currentSalary).toBeNull();
    });
  });

  describe('leaves', () => {
    let leaveId: string;
    const start = shiftDays(`${nextMonthOf(month)}-01`, 9);

    it('earns annual leave with service', async () => {
      const res = await http().get(`${API}/hr/me`).set(worker.auth).expect(200);
      // Two years and ten days at 21 days a year.
      expect(res.body.balances.annual.earned).toBeGreaterThan(42);
      expect(res.body.balances.annual.earned).toBeLessThan(43);
    });

    it('asks, previews and is approved', async () => {
      const types = await http().get(`${API}/hr/leave-types`).set(worker.auth).expect(200);
      const annual = types.body.find((type) => type.code === 'ANNUAL');
      const preview = await http().get(`${API}/hr/me/leaves/preview`).query({ typeId: annual.id, startDate: start, endDate: shiftDays(start, 4) }).set(worker.auth).expect(200);
      expect(preview.body.days).toBe(5);
      const created = await http().post(`${API}/hr/me/leaves`).set(worker.auth).field('typeId', annual.id).field('startDate', start).field('endDate', shiftDays(start, 4)).expect(201);
      expect(created.body.status).toBe('PENDING');
      leaveId = created.body.id;
      // Overlapping and over-balance requests are refused.
      await http().post(`${API}/hr/me/leaves`).set(worker.auth).field('typeId', annual.id).field('startDate', shiftDays(start, 2)).field('endDate', shiftDays(start, 6)).expect(409);
      await http().post(`${API}/hr/me/leaves`).set(worker.auth).field('typeId', annual.id).field('startDate', shiftDays(start, 20)).field('endDate', shiftDays(start, 60)).expect(400);
      // The employee cannot decide their own request.
      await http().post(`${API}/hr/leaves/${leaveId}/decision`).set(worker.auth).send({ decision: 'APPROVE' }).expect(403);
      const approved = await http().post(`${API}/hr/leaves/${leaveId}/decision`).set(admin.auth).send({ decision: 'APPROVE' }).expect(201);
      expect(approved.body.status).toBe('APPROVED');
    });

    it('pays sick leave in tiers', async () => {
      const sick = await prisma.leaveType.findUniqueOrThrow({ where: { code: 'SICK' } });
      const from = shiftDays(start, 30);
      const res = await http()
        .post(`${API}/hr/leaves`)
        .set(admin.auth)
        .field('userId', workerId)
        .field('typeId', sick.id)
        .field('startDate', from)
        .field('endDate', shiftDays(from, 39))
        .attach('files', Buffer.from('%PDF-1.4 test'), 'report.pdf')
        .expect(201);
      expect(res.body).toMatchObject({ status: 'APPROVED', days: 40, fullPayDays: 30, partialPayDays: 10, unpaidDays: 0 });
      await http().post(`${API}/hr/leaves/${res.body.id}/cancel`).set(admin.auth).send({ reason: 'سُجّلت للاختبار' }).expect(201);
    });
  });

  describe('advances, deductions and the payroll', () => {
    let advanceId: string;
    let lineId: string;
    let runId: string;

    it('checks an advance against the salary', async () => {
      // 4,000 in 4 installments is 1,000 a month, beyond 10% of an 8,000 wage.
      await http().post(`${API}/hr/me/advances`).set(worker.auth).send({ amount: 4000, installments: 4, reason: 'ظرف عائلي' }).expect(400);
      const res = await http().post(`${API}/hr/me/advances`).set(worker.auth).send({ amount: 3000, installments: 6, firstMonth: month, reason: 'ظرف عائلي' }).expect(201);
      expect(res.body).toMatchObject({ status: 'PENDING', installmentAmount: 500 });
      advanceId = res.body.id;
      await http().post(`${API}/hr/me/advances`).set(worker.auth).send({ amount: 1000, installments: 2, reason: 'أخرى' }).expect(409);
      await http().post(`${API}/hr/advances/${advanceId}/decision`).set(admin.auth).send({ decision: 'APPROVE' }).expect(201);
      const paid = await http().post(`${API}/hr/advances/${advanceId}/disburse`).set(admin.auth).send({ method: 'BANK', bankReference: 'TRX-1' }).expect(201);
      expect(paid.body).toMatchObject({ status: 'DISBURSED', remaining: 3000 });
    });

    it('turns a salary-deduction penalty into a deduction, within the legal cap', async () => {
      await http().post(`${API}/staff-penalties`).set(admin.auth).send({ userId: workerId, type: 'DEDUCTION', amount: 2000, reason: 'أكثر من أجر خمسة أيام' }).expect(400);
      await http().post(`${API}/staff-penalties`).set(admin.auth).send({ userId: workerId, type: 'DEDUCTION', amount: 300, reason: 'تأخر متكرر' }).expect(201);
      const pending = await prisma.payrollAdjustment.findFirstOrThrow({ where: { userId: workerId, category: 'PENALTY' } });
      expect(Number(pending.amount)).toBe(300);
    });

    it('works the month out', async () => {
      const unpaid = await prisma.leaveType.findUniqueOrThrow({ where: { code: 'UNPAID' } });
      await http().post(`${API}/hr/leaves`).set(admin.auth).field('userId', workerId).field('typeId', unpaid.id).field('startDate', `${month}-01`).field('endDate', `${month}-03`).expect(201);
      await http().post(`${API}/hr/adjustments`).set(admin.auth).send({ userId: workerId, category: 'BONUS', amount: 250, reason: 'أداء متميز' }).expect(201);

      const res = await http().post(`${API}/hr/payroll`).set(admin.auth).send({ month }).expect(201);
      runId = res.body.id;
      const line = res.body.lines.find((row) => row.userId === workerId);
      lineId = line.id;
      const leaveDeduction = Math.round(3 * (8000 / 30) * (30 / daysIn(month)) * 100) / 100;
      expect(line.gross).toBe(8250);
      expect(line.leaveDeduction).toBeCloseTo(leaveDeduction, 1);
      expect(line.gosiEmployee).toBeCloseTo(731.25, 2);
      expect(line.advanceDeduction).toBe(500);
      expect(line.otherDeductions).toBe(300);
      expect(line.net).toBeCloseTo(8250 - leaveDeduction - 731.25 - 500 - 300, 1);
    });

    it('asks for a new calculation after a change, then freezes on approval', async () => {
      await http().post(`${API}/hr/adjustments`).set(admin.auth).send({ userId: workerId, category: 'OTHER_DEDUCTION', amount: 50, reason: 'غرامة مرور' }).expect(201);
      await http().post(`${API}/hr/payroll/${runId}/approve`).set(admin.auth).expect(409);
      await http().post(`${API}/hr/payroll/${runId}/calculate`).set(admin.auth).expect(201);
      const approved = await http().post(`${API}/hr/payroll/${runId}/approve`).set(admin.auth).expect(201);
      expect(approved.body.status).toBe('APPROVED');

      const advance = await http().get(`${API}/hr/advances/${advanceId}`).set(admin.auth).expect(200);
      expect(advance.body.remaining).toBe(2500);
      expect((await prisma.payrollAdjustment.findFirstOrThrow({ where: { userId: workerId, category: 'PENALTY' } })).status).toBe('APPLIED');

      await http().post(`${API}/hr/adjustments`).set(admin.auth).send({ userId: workerId, category: 'BONUS', amount: 10, month, reason: 'متأخرة' }).expect(409);
      await http().post(`${API}/hr/payroll/${runId}/calculate`).set(admin.auth).expect(409);
      await expect(prisma.payrollLine.update({ where: { id: lineId }, data: { net: 1 } })).rejects.toThrow();
    });

    it('pays by transfer and shows the employee the payslip', async () => {
      const file = await http().get(`${API}/hr/payroll/${runId}/bank-file`).set(admin.auth).expect(200);
      expect(file.text).toContain('SA0380000000608010167519');
      const paid = await http().post(`${API}/hr/payroll/${runId}/pay`).set(admin.auth).send({ lineIds: [lineId], method: 'BANK', bankReference: 'WPS-1' }).expect(201);
      expect(paid.body.lines.find((row) => row.id === lineId).paidAt).toBeTruthy();
      const slip = await http().get(`${API}/hr/me/payslips/${lineId}`).set(worker.auth).expect(200);
      expect(slip.body.items.some((item) => item.code === 'GOSI_EMPLOYER' && item.kind === 'EMPLOYER')).toBe(true);
    });

    it('approves and pays a whole month in one step, leaving transfers for the bank file until their reference', async () => {
      const previous = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
      const run = (await http().post(`${API}/hr/payroll`).set(admin.auth).send({ month: previous }).expect(201)).body;
      const needs = (await http().get(`${API}/hr/payroll/${run.id}/payment-needs`).set(admin.auth).expect(200)).body;
      expect(needs.bank.count).toBeGreaterThan(0);

      const result = (await http().post(`${API}/hr/payroll/${run.id}/approve-and-pay`).set(admin.auth).send({}).expect(201)).body;
      expect(result).toMatchObject({ status: 'APPROVED', paidLines: needs.cash.count, bankPending: needs.bank.count });
      // Still listed for the bank, then recorded once the transfer has its reference.
      expect((await http().get(`${API}/hr/payroll/${run.id}/bank-file`).set(admin.auth).expect(200)).text).toContain('SA0380000000608010167519');
      const bankLines = result.lines.filter((line) => !line.paidAt).map((line) => line.id);
      const paid = await http().post(`${API}/hr/payroll/${run.id}/pay`).set(admin.auth).send({ lineIds: bankLines, method: 'BANK', bankReference: 'WPS-PREV' }).expect(201);
      expect(paid.body.status).toBe('PAID');
      await http().post(`${API}/hr/payroll/${run.id}/approve-and-pay`).set(admin.auth).send({}).expect(409);
    });
  });

  describe('final settlement', () => {
    let settlementId: string;

    it('works out the award and what is still owed', async () => {
      const res = await http().post(`${API}/hr/settlements`).set(admin.auth).send({ userId: workerId, terminationDate: today, reason: 'RESIGNATION' }).expect(201);
      settlementId = res.body.id;
      // A resignation after two to five years earns a third of the award.
      expect(res.body.awardShare).toBeCloseTo(0.3333, 3);
      expect(res.body.advanceBalance).toBe(2500);
      expect(res.body.status).toBe('DRAFT');
    });

    it('will not end the service while approved leave runs past the last day', async () => {
      await http().post(`${API}/hr/settlements/${settlementId}/approve`).set(admin.auth).expect(409);
      const leave = await prisma.leaveRequest.findFirstOrThrow({ where: { userId: workerId, status: 'APPROVED', startDate: { gt: new Date(`${today}T00:00:00Z`) } } });
      await http().post(`${API}/hr/leaves/${leave.id}/cancel`).set(admin.auth).send({ reason: 'انتهاء الخدمة' }).expect(201);
    });

    it('ends the employment on approval', async () => {
      // The figures moved with the cancelled leave, so the first approval asks for a review.
      const first = await http().post(`${API}/hr/settlements/${settlementId}/approve`).set(admin.auth);
      if (first.status === 409) await http().post(`${API}/hr/settlements/${settlementId}/approve`).set(admin.auth).expect(201);
      else expect(first.status).toBe(201);
      const profile = await prisma.employeeProfile.findUniqueOrThrow({ where: { userId: workerId } });
      expect(profile.status).toBe('TERMINATED');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: workerId } })).blockedAt).not.toBeNull();
      expect((await prisma.salaryAdvance.findUniqueOrThrow({ where: { id: (await prisma.salaryAdvance.findFirstOrThrow({ where: { userId: workerId } })).id } })).status).toBe('SETTLED');
      await http().get(`${API}/hr/me`).set(worker.auth).expect(401);
    });
  });
});
