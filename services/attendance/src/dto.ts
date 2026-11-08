import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class ReadingDto {
  @IsNumber() @Min(-90) @Max(90) lat: number;
  @IsNumber() @Min(-180) @Max(180) lng: number;
  @IsNumber() @Min(0) @Max(100000) accuracy: number;
  @IsOptional() @IsISO8601() capturedAt?: string;
}
export class ClockInDto {
  @IsOptional() @IsString() @Length(10, 60) siteId?: string;
  @IsOptional() @ValidateNested() @Type(() => ReadingDto) reading?: ReadingDto;
  @IsOptional() @IsBoolean() requestReview?: boolean;
  @IsOptional() @IsString() @Length(30, 4096) passkeyProof?: string;
}
export class ClockOutDto extends ClockInDto {
  @IsOptional() @IsString() @MaxLength(2000) workSummary?: string;
}
export class ReviewDto {
  @IsIn(['approved', 'declined']) decision: 'approved' | 'declined';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class CreateExceptionDto {
  @IsIn(['missed_clock_in', 'missed_clock_out', 'location_issue', 'other'])
  type: 'missed_clock_in' | 'missed_clock_out' | 'location_issue' | 'other';
  @IsISO8601() occurredAt: string;
  @IsString() @Length(10, 2000) reason: string;
  @IsOptional() @IsString() @Length(10, 60) sessionId?: string;
  @IsOptional() @IsString() @Length(10, 60) eventId?: string;
  @IsOptional() @IsString() @Length(10, 60) siteId?: string;
  @IsOptional() @IsString() @Length(10, 2000) workSummary?: string;
}
export class ReviewExceptionDto {
  @IsIn(['approved', 'declined', 'needs_info']) decision: 'approved' | 'declined' | 'needs_info';
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class OverrideExceptionDto {
  @IsIn(['approved', 'declined']) decision: 'approved' | 'declined';
  @IsString() @Length(5, 1000) reason: string;
}
export class PhysicalVerificationDto {
  @IsOptional() @IsString() @Length(10, 60) eventId?: string;
  @IsOptional() @IsString() @Length(10, 60) exceptionId?: string;
  @IsIn(['confirmed', 'not_found']) outcome: 'confirmed' | 'not_found';
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class WorkReportActivityDto {
  @IsString() @Length(3, 1000) description: string;
  @IsIn(['completed', 'in_progress', 'blocked']) status: 'completed' | 'in_progress' | 'blocked';
  @IsOptional() @IsString() @Length(10, 60) taskId?: string;
  @IsOptional() @IsNumber() @Min(0) quantity?: number;
  @IsOptional() @IsString() @MaxLength(80) unit?: string;
  @IsOptional() @IsString() @MaxLength(1000) challenge?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}
export class WorkReportDto {
  @IsString() @Length(10, 60) sessionId: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => WorkReportActivityDto)
  activities: WorkReportActivityDto[];
}
export class WorkReportReviewDto {
  @IsIn(['acknowledged', 'clarification', 'rejected'])
  decision: 'acknowledged' | 'clarification' | 'rejected';
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class CreateTaskDto {
  @IsString() @Length(3, 160) title: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsIn(['low', 'normal', 'high', 'urgent']) priority: 'low' | 'normal' | 'high' | 'urgent' = 'normal';
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsISO8601({ strict: true }) dueDate?: string;
  @IsOptional() @IsString() @Length(10, 60) departmentId?: string;
  @IsString() @Length(10, 60) assignedTo: string;
}
export class UpdateTaskDto {
  @IsOptional() @IsString() @Length(3, 160) title?: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string | null;
  @IsOptional() @IsIn(['low', 'normal', 'high', 'urgent']) priority?: 'low' | 'normal' | 'high' | 'urgent';
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsISO8601({ strict: true }) dueDate?: string | null;
  @IsOptional() @IsString() @Length(10, 60) departmentId?: string | null;
  @IsOptional() @IsString() @Length(10, 60) assignedTo?: string;
}
export class TaskProgressDto {
  @IsIn(['in_progress', 'completed', 'blocked', 'cancelled'])
  status: 'in_progress' | 'completed' | 'blocked' | 'cancelled';
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}
const IP = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/;
export class SiteDto {
  @IsString() @Length(2, 120) name: string;
  @IsNumber() @Min(-90) @Max(90) lat: number;
  @IsNumber() @Min(-180) @Max(180) lng: number;
  @IsInt() @Min(20) @Max(5000) radiusM: number;
  @IsOptional() @IsInt() @Min(10) @Max(1000) accuracyLimitM?: number;
  @IsOptional() @IsString() @Length(3, 60) timezone?: string;
  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) shiftStart?: string;
  @IsOptional() @IsInt() @Min(0) @Max(180) graceMinutes?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @Matches(IP, { each: true }) allowedIps?: string[];
  @IsOptional() @IsBoolean() requireNetwork?: boolean;
}
