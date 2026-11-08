import { Prisma } from '@prisma/client';
import { PrismaExceptionFilter } from '../src/common/filters/prisma-exception.filter';

// No database: the wording below is what Prisma 5 raises on PostgreSQL 18 when RESTRICT blocks a delete.
const RESTRICT_MESSAGE = 'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23001", message: "violates RESTRICT setting of foreign key constraint" }) })';

const answerTo = (exception: unknown) => {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = { switchToHttp: () => ({ getResponse: () => ({ status }) }) };
  new PrismaExceptionFilter().catch(exception as never, host as never);
  return (status.mock.calls as unknown as number[][])[0][0];
};

describe('database errors as API answers', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('answers 409 when PostgreSQL 18 blocks a delete with RESTRICT', () => {
    expect(answerTo(new Prisma.PrismaClientUnknownRequestError(RESTRICT_MESSAGE, { clientVersion: 'test' }))).toBe(409);
  });

  it('answers 409 for the code older PostgreSQL versions lead to', () => {
    expect(answerTo(new Prisma.PrismaClientKnownRequestError('blocked', { code: 'P2003', clientVersion: 'test' }))).toBe(409);
  });

  it('still answers 500 for any other unknown database error', () => {
    expect(answerTo(new Prisma.PrismaClientUnknownRequestError('PostgresError { code: "57014" }', { clientVersion: 'test' }))).toBe(500);
  });
});
