import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, MaxLength, Min } from 'class-validator';

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export const PAGE_SIZE = 50;

export const PAYMENT_STATES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUND_WALLET', 'REFUND_ORIGINAL', 'REFUND_PENDING'] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export class PaymentsQuery {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month?: string;

  @IsOptional()
  @IsIn(PAYMENT_STATES)
  state?: PaymentState;

  @IsOptional()
  @IsIn(['mada', 'card', 'wallet_balance', 'cash', 'network', 'transfer'])
  method?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

export const CANCELLATION_TABS = ['review', 'refunding', 'finished'] as const;
export type CancellationTab = (typeof CANCELLATION_TABS)[number];

export class CancellationsQuery {
  @IsOptional()
  @IsIn(CANCELLATION_TABS)
  tab?: CancellationTab;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

export class ExecuteRefundDto {
  /** Required by the service for anything but cash, which leaves its trace in the drawer instead. */
  @IsOptional()
  @trimmed()
  @IsString()
  @Length(3, 100, { message: 'رقم المرجع من 3 إلى 100 حرف' })
  gatewayReference?: string;
}

export class MoveRefundToWalletDto {
  @trimmed()
  @IsString()
  @Length(3, 300, { message: 'اكتب سبب تعذر الرد إلى وسيلة الدفع' })
  reason: string;
}
