export const DEFAULT_TENANT_SLUG = 'default';
export const SESSION_COOKIE_NAME = 'idp_session';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
export const SESSION_TOUCH_INTERVAL_MS = 1000 * 60 * 5;
export const PASSWORD_CREDENTIAL_TYPE = 'password';
export const LOCAL_IDENTITY_PROVIDER = 'local';

// MFA credential 타입
export const TOTP_CREDENTIAL_TYPE = 'totp';
export const BACKUP_CODE_CREDENTIAL_TYPE = 'backup_code';

// AMR (Authentication Methods References) 값
export const AMR_PASSWORD = 'pwd';
export const AMR_TOTP = 'totp';
export const AMR_BACKUP_CODE = 'swk'; // software key (RFC 8176 유사)
