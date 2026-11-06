import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { ROLES, Role } from './security';

const SLUG = /^[a-z0-9][a-z0-9-]{1,30}$/;
const PHONE = /^\+?[0-9 ]{9,16}$/;

export class LoginDto {
  @Matches(SLUG) organisation: string;
  @IsString() @Length(1, 32) staffNumber: string;
  @IsString() @Length(1, 128) password: string; // a password or a PIN
}
export class ActivateDto {
  @Matches(SLUG) organisation: string;
  @IsString() @Length(1, 32) staffNumber: string;
  @IsString() @Length(6, 20) activationCode: string;
  @IsIn(['password', 'pin']) credentialType: 'password' | 'pin';
  @IsString() @Length(1, 128) secret: string;
  @IsOptional() @Matches(PHONE) phone?: string;
}
export class RefreshDto { @IsString() @Length(20, 200) refreshToken: string }
export class ForgotDto {
  @Matches(SLUG) organisation: string;
  @IsString() @Length(1, 32) staffNumber: string;
}
export class ResetDto {
  @IsString() @Length(20, 200) token: string;
  @IsString() @MaxLength(128) newPassword: string;
}
export class CreateUserDto {
  @IsString() @Length(1, 32) staffNumber: string;
  @IsString() @Length(2, 120) fullName: string;
  @IsIn(ROLES) role: Role;
  @IsOptional() @IsString() @Length(10, 60) supervisorId?: string;
  @IsOptional() @IsString() @Length(10, 60) departmentId?: string;
  @IsOptional() @IsString() @Length(2, 80) jobTitle?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @Matches(PHONE) phone?: string;
}
export class DepartmentDto {
  @IsString() @Length(2, 80) name: string;
  @IsOptional() @Matches(/^[A-Za-z0-9-]{1,20}$/) code?: string;
  @IsOptional() @IsString() @Length(10, 60) managerUserId?: string;
}
export class ReassignDto {
  @IsString() @Length(10, 60) supervisorId: string;
  @IsOptional() @IsString() @Length(4, 200) reason?: string;
}
export class StatusChangeDto {
  @IsIn(['active', 'deactivated']) status: 'active' | 'deactivated';
  @IsOptional() @IsString() @Length(4, 200) reason?: string;
}
export class PlatformOrgDto {
  @IsString() @Length(2, 120) name: string;
  @Matches(SLUG) slug: string;
  @IsString() @Length(1, 32) adminStaffNumber: string;
  @IsString() @Length(2, 120) adminName: string;
  @IsOptional() @IsEmail() adminEmail?: string;
  @IsOptional() @Matches(PHONE) adminPhone?: string;
}
export class PlatformUserDto {
  @IsString() @Length(1, 32) staffNumber: string;
  @IsString() @Length(2, 120) fullName: string;
  @IsIn(ROLES) role: Role;
  @IsOptional() @IsString() @Length(1, 32) supervisorStaffNumber?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @Matches(PHONE) phone?: string;
}
