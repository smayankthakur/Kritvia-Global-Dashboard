import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min
} from "class-validator";

export class CreateOnCallScheduleDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsIn(["DAILY", "WEEKLY"])
  handoffInterval?: "DAILY" | "WEEKLY";

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(23)
  handoffHour?: number;

  @IsOptional()
  @IsDateString()
  startAt?: string;

  @IsOptional()
  @IsBoolean()
  coverageEnabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsIn(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"], { each: true })
  coverageDays?: string[];

  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/)
  coverageStart?: string;

  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/)
  coverageEnd?: string;

  @IsOptional()
  @IsUUID()
  fallbackScheduleId?: string;
}

export class UpdateOnCallScheduleDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsIn(["DAILY", "WEEKLY"])
  handoffInterval?: "DAILY" | "WEEKLY";

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(23)
  handoffHour?: number;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsDateString()
  startAt?: string;

  @IsOptional()
  @IsBoolean()
  coverageEnabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsIn(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"], { each: true })
  coverageDays?: string[];

  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/)
  coverageStart?: string;

  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/)
  coverageEnd?: string;

  @IsOptional()
  @IsUUID()
  fallbackScheduleId?: string | null;
}

export class CreateOnCallMemberDto {
  @IsUUID()
  userId!: string;

  @IsIn(["PRIMARY", "SECONDARY"])
  tier!: "PRIMARY" | "SECONDARY";

  @Type(() => Number)
  @IsInt()
  @Min(1)
  order!: number;
}

export class UpdateOnCallMemberDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  order?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateOnCallOverrideDto {
  @IsUUID()
  scheduleId!: string;

  @IsIn(["PRIMARY", "SECONDARY"])
  tier!: "PRIMARY" | "SECONDARY";

  @IsOptional()
  @IsUUID()
  fromUserId?: string;

  @IsUUID()
  toUserId!: string;

  @IsDateString()
  startAt!: string;

  @IsDateString()
  endAt!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class CreateHolidayCalendarDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  timezone?: string;
}

export class UpdateHolidayCalendarDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}

export class CreateHolidayEntryDto {
  @IsDateString()
  startDate!: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  title?: string;
}

export class LinkScheduleCalendarDto {
  @IsUUID()
  calendarId!: string;
}
