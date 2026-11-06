import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

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
}
export class ClockOutDto extends ClockInDto {
  @IsString() @Length(10, 2000) workSummary: string;
}
export class ReviewDto {
  @IsIn(['approved', 'declined']) decision: 'approved' | 'declined';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
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
