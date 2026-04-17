#!/usr/bin/env bun
/**
 * 프로젝트 최초 클론 후 셋업 자동화 스크립트
 * Usage: bun run scripts/setup.ts [options]
 */

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';

// ─── ANSI Colors ─────────────────────────────────────────────────────────────
const C = {
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	red: '\x1b[31m',
	cyan: '\x1b[36m',
	reset: '\x1b[0m',
	bold: '\x1b[1m'
} as const;

function green(s: string) {
	return `${C.green}${s}${C.reset}`;
}
function yellow(s: string) {
	return `${C.yellow}${s}${C.reset}`;
}
function red(s: string) {
	return `${C.red}${s}${C.reset}`;
}
function cyan(s: string) {
	return `${C.cyan}${s}${C.reset}`;
}

// ─── Paths ────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER_EXAMPLE = path.join(ROOT, 'wrangler.example.jsonc');
const WRANGLER_JSONC = path.join(ROOT, 'wrangler.jsonc');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const ENV_FILE = path.join(ROOT, '.env');

// ─── CLI Argument Parsing ─────────────────────────────────────────────────────
interface Args {
	dbId?: string;
	dbName?: string;
	previewDbId?: string;
	previewDbName?: string;
	noPreview: boolean;
	migrate?: boolean;
	migratePreview?: boolean;
	signingKey?: string;
	tenantName?: string;
	adminUsername?: string;
	adminEmail?: string;
	adminName?: string;
	adminPassword?: string;
	issuerUrl?: string;
	yes: boolean;
	help: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		noPreview: false,
		yes: false,
		help: false
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--db-id':
				args.dbId = argv[++i];
				break;
			case '--db-name':
				args.dbName = argv[++i];
				break;
			case '--preview-db-id':
				args.previewDbId = argv[++i];
				break;
			case '--preview-db-name':
				args.previewDbName = argv[++i];
				break;
			case '--no-preview':
				args.noPreview = true;
				break;
			case '--migrate':
				args.migrate = true;
				break;
			case '--no-migrate':
				args.migrate = false;
				break;
			case '--migrate-preview':
				args.migratePreview = true;
				break;
			case '--no-migrate-preview':
				args.migratePreview = false;
				break;
			case '--signing-key':
				args.signingKey = argv[++i];
				break;
			case '--tenant-name':
				args.tenantName = argv[++i];
				break;
			case '--admin-username':
				args.adminUsername = argv[++i];
				break;
			case '--admin-email':
				args.adminEmail = argv[++i];
				break;
			case '--admin-name':
				args.adminName = argv[++i];
				break;
			case '--admin-password':
				args.adminPassword = argv[++i];
				break;
			case '--issuer-url':
				args.issuerUrl = argv[++i];
				break;
			case '-y':
			case '--yes':
				args.yes = true;
				break;
			case '-h':
			case '--help':
				args.help = true;
				break;
		}
	}

	return args;
}

function printHelp() {
	console.log(`
${cyan('사용법:')} bun run scripts/setup.ts [옵션]

${cyan('옵션:')}
  --db-id <id>              기존 D1 DB ID 직접 지정
  --db-name <name>          새로 생성할 D1 DB 이름
  --preview-db-id <id>      기존 프리뷰 D1 DB ID 직접 지정
  --preview-db-name <name>  새로 생성할 프리뷰 D1 DB 이름
  --no-preview              프리뷰 DB 미사용
  --migrate                 마이그레이션 자동 진행
  --no-migrate              마이그레이션 건너뜀
  --migrate-preview         프리뷰 DB 마이그레이션 자동 진행
  --no-migrate-preview      프리뷰 DB 마이그레이션 건너뜀
  --signing-key <secret>    IDP_SIGNING_KEY_SECRET 값
  --tenant-name <name>      조직(테넌트) 이름
  --admin-username <id>     초기 관리자 아이디
  --admin-email <email>     초기 관리자 이메일
  --admin-name <name>       초기 관리자 표시 이름
  --admin-password <pass>   초기 관리자 비밀번호 (생략 시 자동 생성)
  --issuer-url <url>        IDP Issuer URL (배포 도메인)
  -y, --yes                 모든 확인 프롬프트 자동 승인
  -h, --help                도움말 출력
`);
}

// ─── Readline Helpers ─────────────────────────────────────────────────────────
let rl: readline.Interface | null = null;

function getRL(): readline.Interface {
	if (!rl) {
		rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout
		});
	}
	return rl;
}

function closeRL() {
	if (rl) {
		rl.close();
		rl = null;
	}
}

async function ask(prompt: string, defaultVal?: string): Promise<string> {
	const displayPrompt =
		defaultVal !== undefined
			? `${yellow(prompt)} [기본값: ${defaultVal}]: `
			: `${yellow(prompt)}: `;

	return new Promise((resolve) => {
		getRL().question(displayPrompt, (answer: string) => {
			const trimmed = answer.trim();
			resolve(trimmed === '' && defaultVal !== undefined ? defaultVal : trimmed);
		});
	});
}

async function confirm(prompt: string, defaultYes = true): Promise<boolean> {
	const hint = defaultYes ? '[Y/n]' : '[y/N]';
	const displayPrompt = `${yellow(prompt)} ${hint}: `;

	return new Promise((resolve) => {
		getRL().question(displayPrompt, (answer: string) => {
			const trimmed = answer.trim().toLowerCase();
			if (trimmed === '') {
				resolve(defaultYes);
			} else {
				resolve(trimmed === 'y' || trimmed === 'yes');
			}
		});
	});
}

async function select(prompt: string, options: string[]): Promise<number> {
	console.log(`\n${cyan(prompt)}`);
	options.forEach((opt, i) => {
		console.log(`  ${i + 1}) ${opt}`);
	});

	return new Promise((resolve) => {
		const ask = () => {
			getRL().question(`${yellow('선택')} (1-${options.length}): `, (answer: string) => {
				const num = parseInt(answer.trim(), 10);
				if (num >= 1 && num <= options.length) {
					resolve(num);
				} else {
					console.log(red(`1에서 ${options.length} 사이의 숫자를 입력하세요.`));
					ask();
				}
			});
		};
		ask();
	});
}

// ─── Spinner ──────────────────────────────────────────────────────────────────
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

async function runWithSpinner(
	label: string,
	cmd: string,
	args: string[],
	options: { env?: Record<string, string> } = {}
): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }> {
	let frameIdx = 0;
	process.stdout.write(`  ${SPINNER_FRAMES[0]} ${label}`);
	const interval = setInterval(() => {
		process.stdout.write(`\r  ${SPINNER_FRAMES[frameIdx++ % SPINNER_FRAMES.length]} ${label}`);
	}, 80);

	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			cwd: ROOT,
			env: options.env ? { ...process.env, ...options.env } : process.env
		});
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr?.on('data', (d: Buffer) => {
			stderr += d.toString();
		});
		child.on('close', (code: number | null) => {
			clearInterval(interval);
			const success = (code ?? 1) === 0;
			process.stdout.write(`\r  ${success ? green('✓') : red('✗')} ${label}\n`);
			resolve({ success, stdout, stderr, exitCode: code ?? 1 });
		});
	});
}

// ─── Command (inherit 모드용 — db:generate, db:migrate 등) ────────────────────
function runCommand(
	cmd: string,
	args: string[],
	options: { inherit?: boolean; env?: Record<string, string> } = {}
): {
	success: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
} {
	const result = spawnSync(cmd, args, {
		stdio: options.inherit ? 'inherit' : 'pipe',
		cwd: ROOT,
		encoding: 'utf-8',
		env: options.env ? { ...process.env, ...options.env } : process.env
	});

	return {
		success: result.status === 0,
		stdout: typeof result.stdout === 'string' ? result.stdout : '',
		stderr: typeof result.stderr === 'string' ? result.stderr : '',
		exitCode: result.status ?? 1
	};
}

// ─── Wrangler Helpers ─────────────────────────────────────────────────────────
interface D1Database {
	name: string;
	uuid: string;
}

/** wrangler whoami → { loggedIn, accountId } */
async function wranglerWhoami(): Promise<{ loggedIn: boolean; accountId: string | null }> {
	const result = await runWithSpinner('wrangler 인증 확인 중...', 'wrangler', ['whoami']);
	const combined = result.stdout + result.stderr;
	const loggedIn = result.success && !combined.includes('You are not authenticated');
	const match = combined.match(/([0-9a-f]{32})/i);
	return { loggedIn, accountId: match ? match[1] : null };
}

async function createD1Database(name: string): Promise<string | null> {
	const result = await runWithSpinner(`D1 DB 생성 중: ${name}`, 'wrangler', ['d1', 'create', name]);
	if (!result.success) {
		console.error(red(`  D1 DB 생성 실패:\n${result.stderr}`));
		return null;
	}
	const combined = result.stdout + result.stderr;
	const match = combined.match(
		/"?database_id"?\s*[=:]\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i
	);
	if (!match) {
		console.error(red(`  D1 생성 결과에서 database_id를 찾을 수 없습니다:\n${combined}`));
		return null;
	}
	return match[1];
}

let _cachedDbList: D1Database[] | null | undefined = undefined;

async function listD1Databases(): Promise<D1Database[] | null> {
	if (_cachedDbList !== undefined) return _cachedDbList;
	const result = await runWithSpinner('D1 DB 목록 조회 중...', 'wrangler', [
		'd1',
		'list',
		'--json'
	]);
	if (!result.success) {
		console.error(red(`  D1 목록 조회 실패:\n${result.stderr}`));
		_cachedDbList = null;
		return null;
	}
	try {
		_cachedDbList = JSON.parse(result.stdout) as D1Database[];
		return _cachedDbList;
	} catch {
		console.error(red(`  D1 목록 파싱 실패:\n${result.stdout}`));
		_cachedDbList = null;
		return null;
	}
}

// ─── File Helpers ─────────────────────────────────────────────────────────────
function copyFile(src: string, dest: string) {
	fs.copyFileSync(src, dest);
}

function readFile(filePath: string): string {
	return fs.readFileSync(filePath, 'utf-8');
}

function writeFile(filePath: string, content: string) {
	fs.writeFileSync(filePath, content, 'utf-8');
}

/** mkdtempSync으로 안전한 임시 파일 생성 (symlink attack 방지) */
function createTempFile(prefix: string, content: string): { filePath: string; cleanup: () => void } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const filePath = path.join(tmpDir, 'content.sql');
	fs.writeFileSync(filePath, content, { mode: 0o600 });
	return {
		filePath,
		cleanup: () => {
			try { fs.unlinkSync(filePath); } catch { /* ignore */ }
			try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
		}
	};
}

function replaceAll(content: string, search: string, replacement: string): string {
	return content.split(search).join(replacement);
}

/** .env 파일을 파싱해 key=value 맵 반환 */
function loadEnvFile(envPath: string): Record<string, string> {
	if (!fs.existsSync(envPath)) return {};
	const env: Record<string, string> = {};
	for (const line of readFile(envPath).split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq < 0) continue;
		const key = trimmed.slice(0, eq).trim();
		let val = trimmed.slice(eq + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		if (key) env[key] = val;
	}
	return env;
}

// ─── Steps ────────────────────────────────────────────────────────────────────

async function step0_wranglerLogin(args: Args): Promise<string | null> {
	console.log(`\n${cyan('─── 0. wrangler 로그인 체크 ───────────────────────────────')}`);

	const { loggedIn, accountId: detectedId } = await wranglerWhoami();
	let accountId = detectedId;

	if (!loggedIn) {
		console.log(yellow('  wrangler에 로그인하지 않았습니다.'));

		if (args.yes) {
			console.log(red('  DB 생성을 위해 wrangler 로그인이 필요합니다. 종료합니다.'));
			closeRL();
			process.exit(1);
		}

		const doLogin = await confirm('로그인하시겠습니까?', false);
		if (!doLogin) {
			console.log(red('  DB 생성을 위해 wrangler 로그인이 필요합니다. 종료합니다.'));
			closeRL();
			process.exit(1);
		}

		console.log('  wrangler login 실행 중...');
		const result = runCommand('wrangler', ['login'], { inherit: true });
		if (!result.success) {
			console.error(red('  wrangler 로그인 실패. 종료합니다.'));
			closeRL();
			process.exit(1);
		}

		// 로그인 후 재확인
		({ accountId } = await wranglerWhoami());
	}

	if (accountId) {
		console.log(green(`  ✓ wrangler 로그인 확인됨 (Account ID: ${accountId})`));
	}
	return accountId;
}

async function step1_createWranglerJsonc(args: Args) {
	console.log(`\n${cyan('─── 1. wrangler.jsonc 생성 ────────────────────────────────')}`);

	if (fs.existsSync(WRANGLER_JSONC)) {
		let overwrite = args.yes;
		if (!args.yes) {
			overwrite = await confirm('wrangler.jsonc가 이미 존재합니다. 덮어쓰시겠습니까?', false);
		}
		if (!overwrite) {
			console.log('  wrangler.jsonc 유지');
			return;
		}
	}

	copyFile(WRANGLER_EXAMPLE, WRANGLER_JSONC);
	console.log(green('  ✓ wrangler.jsonc 생성 완료'));
}

async function step2_createEnv(args: Args) {
	console.log(`\n${cyan('─── 2. .env 생성 ──────────────────────────────────────────')}`);

	if (fs.existsSync(ENV_FILE)) {
		let overwrite = args.yes;
		if (!args.yes) {
			overwrite = await confirm('.env가 이미 존재합니다. 덮어쓰시겠습니까?', false);
		}
		if (!overwrite) {
			console.log('  .env 유지');
			return;
		}
	}

	copyFile(ENV_EXAMPLE, ENV_FILE);
	console.log(green('  ✓ .env 생성 완료'));
}

async function setupDb(
	label: string,
	nameArg: string | undefined,
	idArg: string | undefined,
	defaultName: string,
	isPreview = false
): Promise<{ id: string; name: string } | null> {
	// If ID directly provided
	if (idArg) {
		console.log(green(`  ✓ ${label} ID: ${idArg}`));
		return { id: idArg, name: defaultName };
	}

	const thirdOption = isPreview ? '미사용' : '나중에 직접 설정 (종료)';
	const choice = await select(`${label} 설정`, [
		'지금 새로 생성',
		'이미 생성된 DB 사용',
		thirdOption
	]);

	if (choice === 3) {
		if (isPreview) {
			console.log('  프리뷰 DB 미사용');
			return null;
		}
		console.log(yellow('  wrangler.jsonc와 .env의 YOUR_D1_DATABASE_ID 를 직접 입력하세요.'));
		closeRL();
		process.exit(0);
	}

	if (choice === 1) {
		// Create new
		const name = nameArg ?? (await ask(`${label} 이름을 입력하세요`, defaultName));
		const id = await createD1Database(name);
		if (!id) {
			console.error(red(`  ${label} 생성 실패. 종료합니다.`));
			closeRL();
			process.exit(1);
		}
		return { id, name };
	}

	// Use existing DB
	const dbs = await listD1Databases();
	if (!dbs || dbs.length === 0) {
		console.error(red('  D1 데이터베이스 목록을 가져올 수 없거나 비어있습니다. 종료합니다.'));
		closeRL();
		process.exit(1);
	}

	const options = dbs!.map((db) => `${db.name} (id: ${db.uuid})`);
	const dbChoice = await select(`사용할 ${label}를 선택하세요`, options);
	const selected = dbs![dbChoice - 1];
	console.log(green(`  ✓ ${selected.name} (id: ${selected.uuid}) 선택됨`));
	return { id: selected.uuid, name: selected.name };
}

async function step3_dbSetup(args: Args): Promise<{
	dbId: string;
	dbName: string;
	previewDbId: string | null;
	previewDbName: string | null;
}> {
	console.log(`\n${cyan('─── 3. D1 데이터베이스 설정 ────────────────────────────────')}`);

	const db = await setupDb('D1 데이터베이스', args.dbName, args.dbId, 'keystone-db');
	if (!db) {
		closeRL();
		throw new Error('DB 설정에 실패했습니다.');
	}

	let previewDbId: string | null = null;
	let previewDbName: string | null = null;

	if (!args.noPreview) {
		if (args.previewDbId) {
			previewDbId = args.previewDbId;
			previewDbName = args.previewDbName ?? `${db.name}-preview`;
			console.log(green(`  ✓ 프리뷰 DB ID: ${previewDbId}`));
		} else {
			const previewDb = await setupDb(
				'프리뷰 D1 데이터베이스',
				args.previewDbName,
				undefined,
				`${db.name}-preview`,
				true
			);
			previewDbId = previewDb?.id ?? null;
			previewDbName = previewDb?.name ?? null;
		}
	}

	return { dbId: db.id, dbName: db.name, previewDbId, previewDbName };
}

async function step4_updateFiles(
	dbId: string,
	previewDbId: string | null,
	accountId: string | null
) {
	console.log(`\n${cyan('─── 4. 파일 업데이트 ──────────────────────────────────────')}`);

	// Update wrangler.jsonc
	let wranglerContent = readFile(WRANGLER_JSONC);
	wranglerContent = replaceAll(wranglerContent, 'YOUR_D1_DATABASE_ID', dbId);

	if (previewDbId) {
		wranglerContent = replaceAll(wranglerContent, 'YOUR_D1_PREVIEW_DATABASE_ID', previewDbId);
		// Uncomment the preview_database_id line if it's commented out
		wranglerContent = wranglerContent.replace(
			/\/\/\s*"preview_database_id":\s*"([^"]+)"/g,
			`"preview_database_id": "$1"`
		);
	}

	writeFile(WRANGLER_JSONC, wranglerContent);
	console.log(green('  ✓ wrangler.jsonc 업데이트 완료'));

	// Update .env
	let envContent = readFile(ENV_FILE);
	if (accountId) {
		envContent = envContent.replace(
			/^CLOUDFLARE_ACCOUNT_ID=".*"$/m,
			`CLOUDFLARE_ACCOUNT_ID="${accountId}"`
		);
	}
	envContent = envContent.replace(
		/^CLOUDFLARE_D1_DATABASE_ID=".*"$/m,
		`CLOUDFLARE_D1_DATABASE_ID="${dbId}"`
	);

	if (previewDbId) {
		envContent = envContent.replace(
			/^CLOUDFLARE_D1_PREVIEW_DATABASE_ID=".*"$/m,
			`CLOUDFLARE_D1_PREVIEW_DATABASE_ID="${previewDbId}"`
		);
	}

	writeFile(ENV_FILE, envContent);
	console.log(green('  ✓ .env 업데이트 완료'));
}

// ─── Migration Conflict Detection ────────────────────────────────────────────

async function getExistingTables(
	dbName: string,
	env: Record<string, string>
): Promise<string[] | null> {
	const result = await runWithSpinner(
		`기존 테이블 조회 중 (${dbName})...`,
		'wrangler',
		[
			'd1',
			'execute',
			dbName,
			'--remote',
			'--json',
			'--command',
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
		],
		{ env }
	);
	if (!result.success) {
		console.warn(yellow(`  테이블 조회 실패 (건너뜀): ${result.stderr.slice(0, 120)}`));
		return null;
	}
	try {
		const parsed = JSON.parse(result.stdout) as Array<{ results: Array<{ name: string }> }>;
		return (parsed[0]?.results ?? []).map((r) => r.name);
	} catch {
		return null;
	}
}

function extractTablesFromMigrations(): string[] {
	const drizzleDir = path.join(ROOT, 'drizzle');
	if (!fs.existsSync(drizzleDir)) return [];
	const tables = new Set<string>();
	for (const file of fs
		.readdirSync(drizzleDir)
		.filter((f) => f.endsWith('.sql'))
		.sort()) {
		const content = readFile(path.join(drizzleDir, file));
		for (const m of content.matchAll(/CREATE TABLE [`"]?(\w+)[`"]?\s*\(/gi)) {
			tables.add(m[1]);
		}
	}
	return [...tables];
}

function buildFilteredMigrationSQL(conflicting: Set<string>): string {
	const drizzleDir = path.join(ROOT, 'drizzle');
	const stmts: string[] = [];
	for (const file of fs
		.readdirSync(drizzleDir)
		.filter((f) => f.endsWith('.sql'))
		.sort()) {
		const content = readFile(path.join(drizzleDir, file));
		for (const stmt of content.split('--> statement-breakpoint')) {
			const s = stmt.trim();
			if (!s) continue;
			const tblMatch = s.match(/^CREATE TABLE [`"]?(\w+)[`"]?\s*\(/i);
			if (tblMatch && conflicting.has(tblMatch[1])) continue;
			const idxMatch = s.match(/^CREATE (?:UNIQUE )?INDEX \S+ ON [`"]?(\w+)[`"]?/i);
			if (idxMatch && conflicting.has(idxMatch[1])) continue;
			stmts.push(s);
		}
	}
	return stmts.join(';\n');
}

function buildDrizzleTrackingSQL(): string {
	const drizzleDir = path.join(ROOT, 'drizzle');
	const now = Date.now();
	const lines = [
		`CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, hash TEXT NOT NULL, created_at NUMERIC);`
	];
	for (const file of fs
		.readdirSync(drizzleDir)
		.filter((f) => f.endsWith('.sql'))
		.sort()) {
		const content = readFile(path.join(drizzleDir, file));
		const hash = createHash('sha256').update(content).digest('hex');
		lines.push(
			`INSERT INTO "__drizzle_migrations" (hash, created_at) SELECT '${hash}', ${now} WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE hash = '${hash}');`
		);
	}
	return lines.join('\n');
}

async function handleMigrationConflicts(
	dbName: string,
	env: Record<string, string>,
	args: Args
): Promise<'proceed' | 'done'> {
	const existing = await getExistingTables(dbName, env);
	if (!existing || existing.length === 0) return 'proceed';

	const migrationTables = extractTablesFromMigrations();
	const conflicts = migrationTables.filter((t) => existing.includes(t));
	if (conflicts.length === 0) return 'proceed';

	console.log(yellow(`\n  ⚠  이미 존재하는 테이블 발견 (${dbName}):`));
	conflicts.forEach((t) => console.log(`     - ${t}`));

	let choice: number;
	if (args.yes) {
		choice = 2;
		console.log(yellow('  (--yes 모드) 겹치는 테이블은 건너뜀으로 자동 선택'));
	} else {
		choice = await select('마이그레이션 방식을 선택하세요', [
			'겹치는 테이블 삭제 후 전체 마이그레이션 (데이터 손실 주의)',
			'겹치는 테이블은 건너뛰고 나머지만 마이그레이션'
		]);
	}

	if (choice === 1) {
		const dropSQL = [
			'PRAGMA foreign_keys = OFF;',
			...conflicts.map((t) => `DROP TABLE IF EXISTS \`${t}\`;`),
			'PRAGMA foreign_keys = ON;'
		].join('\n');

		const { filePath: dropTmpFile, cleanup: dropCleanup } = createTempFile('idp-drop-', dropSQL);
		try {
			const dropResult = await runWithSpinner(
				`겹치는 테이블 삭제 중 (${dbName})...`,
				'wrangler',
				['d1', 'execute', dbName, '--remote', '--file', dropTmpFile],
				{ env }
			);
			if (!dropResult.success) {
				console.error(red(`  테이블 삭제 실패:\n${dropResult.stderr}`));
				closeRL();
				process.exit(1);
			}
		} finally {
			dropCleanup();
		}
		console.log(green(`  ✓ ${conflicts.length}개 테이블 삭제 완료 → 전체 마이그레이션 진행`));
		return 'proceed';
	}

	// Option 2: 필터링된 SQL + drizzle tracking
	const combinedSQL =
		buildFilteredMigrationSQL(new Set(conflicts)) + '\n' + buildDrizzleTrackingSQL();
	const { filePath: filteredTmpFile, cleanup: filteredCleanup } = createTempFile('idp-migrate-', combinedSQL);
	try {
		const runResult = await runWithSpinner(
			`필터링된 마이그레이션 실행 중 (${dbName})...`,
			'wrangler',
			['d1', 'execute', dbName, '--remote', '--file', filteredTmpFile],
			{ env }
		);
		if (!runResult.success) {
			console.error(red(`  필터링된 마이그레이션 실패:\n${runResult.stderr}`));
			closeRL();
			process.exit(1);
		}
	} finally {
		filteredCleanup();
	}
	console.log(green(`  ✓ 필터링된 마이그레이션 완료 (drizzle tracking 업데이트됨)`));
	return 'done';
}

// ─────────────────────────────────────────────────────────────────────────────

async function step5_migrate(
	args: Args,
	hasPreviewDb: boolean,
	dbName: string,
	previewDbName: string | null
) {
	console.log(`\n${cyan('─── 5. 마이그레이션 ────────────────────────────────────────')}`);

	let doMigrate = args.migrate;
	if (doMigrate === undefined) {
		doMigrate = await confirm('마이그레이션을 지금 진행하시겠습니까?', true);
	}

	if (!doMigrate) {
		console.log('  마이그레이션 건너뜀');
		return;
	}

	// .env 로드 후 Cloudflare 자격증명 확인
	const envVars = loadEnvFile(ENV_FILE);

	if (!envVars.CLOUDFLARE_ACCOUNT_ID) {
		console.log(yellow('\n  Cloudflare 계정 ID를 감지할 수 없습니다.'));
		const id = await ask('CLOUDFLARE_ACCOUNT_ID 직접 입력', '');
		if (!id) {
			console.error(red('  계정 ID가 없으면 마이그레이션을 실행할 수 없습니다.'));
			closeRL();
			process.exit(1);
		}
		envVars.CLOUDFLARE_ACCOUNT_ID = id;
		let envContent = readFile(ENV_FILE);
		envContent = envContent.replace(
			/^CLOUDFLARE_ACCOUNT_ID=".*"$/m,
			`CLOUDFLARE_ACCOUNT_ID="${id}"`
		);
		writeFile(ENV_FILE, envContent);
	}

	// 토큰 확인 — CLOUDFLARE_D1_TOKEN 또는 CLOUDFLARE_API_TOKEN 중 하나
	const hasToken = (v: string | undefined) => !!v && v.length > 0;
	if (!hasToken(envVars.CLOUDFLARE_D1_TOKEN) && !hasToken(envVars.CLOUDFLARE_API_TOKEN)) {
		console.log(`
  ${cyan('Cloudflare API 토큰이 필요합니다.')}
  아래 URL에서 토큰을 생성하세요:

  ${yellow('https://dash.cloudflare.com/?to=/:account/api-tokens/create')}

  토큰 생성 방법:
    1. [사용자 정의 토큰 만들기] 선택
    2. 권한 추가: [계정] > [D1] > [편집]
    3. 토큰 생성 후 아래에 붙여넣기
`);
		const token = await ask('CLOUDFLARE_API_TOKEN 입력', '');
		if (!token) {
			console.error(red('  토큰이 없으면 마이그레이션을 실행할 수 없습니다.'));
			closeRL();
			process.exit(1);
		}
		let envContent = readFile(ENV_FILE);
		if (/^CLOUDFLARE_D1_TOKEN=/m.test(envContent)) {
			envContent = envContent.replace(
				/^CLOUDFLARE_D1_TOKEN=".*"$/m,
				`CLOUDFLARE_D1_TOKEN="${token}"`
			);
		} else {
			envContent += `\nCLOUDFLARE_API_TOKEN="${token}"\n`;
		}
		writeFile(ENV_FILE, envContent);
	}

	// 파일 재로드로 최신 값 보장
	const freshEnv = loadEnvFile(ENV_FILE);
	const migrateEnv: Record<string, string> = {
		CLOUDFLARE_ACCOUNT_ID: freshEnv.CLOUDFLARE_ACCOUNT_ID ?? '',
		CLOUDFLARE_D1_DATABASE_ID: freshEnv.CLOUDFLARE_D1_DATABASE_ID ?? '',
		CLOUDFLARE_D1_PREVIEW_DATABASE_ID: freshEnv.CLOUDFLARE_D1_PREVIEW_DATABASE_ID ?? '',
		...(hasToken(freshEnv.CLOUDFLARE_D1_TOKEN)
			? { CLOUDFLARE_D1_TOKEN: freshEnv.CLOUDFLARE_D1_TOKEN! }
			: {}),
		...(hasToken(freshEnv.CLOUDFLARE_API_TOKEN)
			? { CLOUDFLARE_API_TOKEN: freshEnv.CLOUDFLARE_API_TOKEN! }
			: {})
	};

	// Generate migrations
	console.log('\n  bun run db:generate 실행 중...');
	const generateResult = runCommand('bun', ['run', 'db:generate'], {
		inherit: true,
		env: migrateEnv
	});
	if (!generateResult.success) {
		console.error(red('  db:generate 실패'));
		closeRL();
		process.exit(1);
	}
	console.log(green('  ✓ db:generate 완료'));

	// 프로덕션 DB 충돌 확인 후 마이그레이션
	const prodConflict = await handleMigrationConflicts(dbName, migrateEnv, args);
	if (prodConflict !== 'done') {
		console.log('  bun run db:migrate 실행 중...');
		const migrateResult = runCommand('bun', ['run', 'db:migrate'], {
			inherit: true,
			env: migrateEnv
		});
		if (!migrateResult.success) {
			console.error(red('  db:migrate 실패'));
			closeRL();
			process.exit(1);
		}
		console.log(green('  ✓ db:migrate 완료'));
	}

	// 프리뷰 DB 마이그레이션
	if (hasPreviewDb && previewDbName) {
		let doMigratePreview = args.migratePreview;
		if (doMigratePreview === undefined) {
			doMigratePreview = await confirm('프리뷰 DB에도 마이그레이션을 진행하시겠습니까?', true);
		}

		if (doMigratePreview) {
			const previewEnv = { ...migrateEnv, CLOUDFLARE_IS_PREVIEW: 'true' };
			const previewConflict = await handleMigrationConflicts(previewDbName, previewEnv, args);
			if (previewConflict !== 'done') {
				console.log('  bun run db:migrate:preview 실행 중...');
				const previewResult = runCommand('bun', ['run', 'db:migrate:preview'], {
					inherit: true,
					env: previewEnv
				});
				if (!previewResult.success) {
					console.error(red('  db:migrate:preview 실패'));
					closeRL();
					process.exit(1);
				}
				console.log(green('  ✓ db:migrate:preview 완료'));
			}
		} else {
			console.log('  프리뷰 DB 마이그레이션 건너뜀');
		}
	}
}

// ─── Password Hashing (same format as src/lib/server/auth/password.ts) ────────

async function hashPasswordForSetup(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits']
	);
	const derived = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 },
		keyMaterial,
		256
	);
	const saltB64 = btoa(String.fromCharCode(...salt));
	const hashB64 = btoa(String.fromCharCode(...new Uint8Array(derived)));
	return `pbkdf2:sha256:100000:${saltB64}:${hashB64}`;
}

function generateRandomPassword(length = 20): string {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

// ─── Admin Seeding ────────────────────────────────────────────────────────────

interface AdminSeedData {
	tenantName: string;
	email: string;
	username: string;
	displayName: string;
	hashedPassword: string;
}

async function seedAdminToDb(
	dbName: string,
	data: AdminSeedData,
	env: Record<string, string>,
	isPreview = false
): Promise<boolean> {
	const now = Date.now();
	const tenantId = crypto.randomUUID();
	const userId = crypto.randomUUID();
	const credId = crypto.randomUUID();
	const identityId = crypto.randomUUID();

	const esc = (s: string) => s.replace(/'/g, "''");

	const sql = [
		// 테넌트 생성 (이미 존재하면 이름만 업데이트)
		`INSERT INTO tenants (id, slug, name, status, created_at, updated_at) VALUES ('${tenantId}', 'default', '${esc(data.tenantName)}', 'active', ${now}, ${now}) ON CONFLICT(slug) DO UPDATE SET name = excluded.name;`,
		// 동일 이메일 admin이 없을 때만 삽입
		`INSERT INTO users (id, tenant_id, email, username, display_name, role, status, created_at, updated_at) SELECT '${userId}', t.id, '${esc(data.email)}', '${esc(data.username)}', '${esc(data.displayName)}', 'admin', 'active', ${now}, ${now} FROM tenants t WHERE t.slug = 'default' AND NOT EXISTS (SELECT 1 FROM users WHERE email = '${esc(data.email)}' AND tenant_id = t.id);`,
		// 비밀번호 credential (user INSERT가 성공한 경우에만)
		`INSERT INTO credentials (id, user_id, type, secret, label, created_at) SELECT '${credId}', '${userId}', 'password', '${esc(data.hashedPassword)}', '비밀번호', ${now} WHERE EXISTS (SELECT 1 FROM users WHERE id = '${userId}') AND NOT EXISTS (SELECT 1 FROM credentials WHERE user_id = '${userId}' AND type = 'password');`,
		// local identity
		`INSERT INTO identities (id, tenant_id, user_id, provider, subject, email, linked_at) SELECT '${identityId}', t.id, '${userId}', 'local', '${esc(data.email)}', '${esc(data.email)}', ${now} FROM tenants t WHERE t.slug = 'default' AND NOT EXISTS (SELECT 1 FROM identities WHERE user_id = '${userId}' AND provider = 'local');`
	].join('\n');

	const { filePath: seedTmpFile, cleanup: seedCleanup } = createTempFile('idp-seed-', sql);
	const actualEnv = isPreview ? { ...env, CLOUDFLARE_IS_PREVIEW: 'true' } : env;
	const label = `관리자 계정 생성 중 (${dbName}${isPreview ? ' preview' : ''})...`;

	try {
		const result = await runWithSpinner(
			label,
			'wrangler',
			['d1', 'execute', dbName, '--remote', '--file', seedTmpFile],
			{ env: actualEnv }
		);

		if (!result.success) {
			console.error(red(`  관리자 계정 생성 실패:\n${result.stderr}`));
			return false;
		}
		return true;
	} finally {
		seedCleanup();
	}
}

async function step5b_bootstrapConfig(
	args: Args,
	dbName: string,
	previewDbName: string | null
): Promise<{ email: string; password: string; generated: boolean } | null> {
	console.log(`\n${cyan('─── 5b. 초기 관리자 계정 생성 ─────────────────────────────────')}`);

	const tenantName = args.tenantName ?? (await ask('조직(테넌트) 이름', 'My Organization'));
	const username = args.adminUsername ?? (await ask('초기 관리자 아이디', 'admin'));
	const email = args.adminEmail ?? (await ask('초기 관리자 이메일', 'admin@example.com'));
	const displayName = args.adminName ?? (await ask('초기 관리자 표시 이름', '관리자'));
	const issuerUrl = args.issuerUrl ?? (await ask('IDP Issuer URL', 'http://localhost:5173'));

	let password: string;
	let generated = false;
	if (args.adminPassword) {
		password = args.adminPassword;
	} else {
		const input = await ask('초기 관리자 비밀번호 (엔터: 자동 생성)', '');
		if (input === '') {
			password = generateRandomPassword(20);
			generated = true;
		} else {
			password = input;
		}
	}

	console.log('  비밀번호 해싱 중...');
	const hashedPassword = await hashPasswordForSetup(password);

	// .env에 민감하지 않은 값만 저장
	if (fs.existsSync(ENV_FILE)) {
		let envContent = readFile(ENV_FILE);
		envContent = envContent.replace(
			/^IDP_DEFAULT_TENANT_NAME=".*"$/m,
			`IDP_DEFAULT_TENANT_NAME="${tenantName}"`
		);
		envContent = envContent.replace(/^IDP_ISSUER_URL=".*"$/m, `IDP_ISSUER_URL="${issuerUrl}"`);
		writeFile(ENV_FILE, envContent);
		console.log(green('  ✓ .env 업데이트 완료 (테넌트 이름, Issuer URL)'));
	}

	const envVars = loadEnvFile(ENV_FILE);
	const wranglerEnv: Record<string, string> = {
		CLOUDFLARE_ACCOUNT_ID: envVars.CLOUDFLARE_ACCOUNT_ID ?? '',
		...(envVars.CLOUDFLARE_D1_TOKEN ? { CLOUDFLARE_D1_TOKEN: envVars.CLOUDFLARE_D1_TOKEN } : {}),
		...(envVars.CLOUDFLARE_API_TOKEN ? { CLOUDFLARE_API_TOKEN: envVars.CLOUDFLARE_API_TOKEN } : {})
	};

	const data: AdminSeedData = { tenantName, email, username, displayName, hashedPassword };
	const ok = await seedAdminToDb(dbName, data, wranglerEnv, false);
	if (!ok) return null;

	if (previewDbName) {
		const doPreview =
			args.yes || (await confirm('프리뷰 DB에도 관리자 계정을 생성하시겠습니까?', true));
		if (doPreview) {
			await seedAdminToDb(previewDbName, data, wranglerEnv, true);
		}
	}

	return { email, password, generated };
}

async function step6_signingKey(args: Args) {
	console.log(`\n${cyan('─── 6. 시크릿 설정 ────────────────────────────────────────')}`);

	let signingKey = args.signingKey;

	if (!signingKey) {
		console.log(`  ${cyan('IDP_SIGNING_KEY_SECRET')} 을 설정합니다.`);
		const input = await ask(
			'직접 입력하거나 엔터를 누르면 자동 생성합니다 (openssl rand -base64 32)',
			''
		);

		if (input === '') {
			const result = runCommand('openssl', ['rand', '-base64', '32']);
			if (!result.success) {
				console.error(red('  openssl 실행 실패. 시크릿을 직접 설정하세요.'));
				return;
			}
			signingKey = result.stdout.trim();
			console.log(green(`  ✓ 자동 생성된 시크릿: ${signingKey}`));
		} else {
			signingKey = input;
		}
	}

	// Update .env
	let envContent = readFile(ENV_FILE);
	envContent = envContent.replace(
		/^IDP_SIGNING_KEY_SECRET=".*"$/m,
		`IDP_SIGNING_KEY_SECRET="${signingKey}"`
	);
	writeFile(ENV_FILE, envContent);
	console.log(green('  ✓ IDP_SIGNING_KEY_SECRET .env 업데이트 완료'));
}

function printComplete(
	adminResult?: { email: string; password: string; generated: boolean } | null
) {
	console.log(`\n${green('✓ 셋업 완료!')}`);

	if (adminResult) {
		const passwordLine = yellow(adminResult.password);
		console.log(`
${cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}
  초기 관리자 계정 정보${adminResult.generated ? ' (자동 생성됨)' : ''}

  이메일  : ${yellow(adminResult.email)}`);
		console.log(`  비밀번호: ${passwordLine}`);
		console.log(`${adminResult.generated ? `${red('⚠️  이 비밀번호는 다시 표시되지 않습니다. 반드시 저장하세요.')}` : ''}
${cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}
`);
	}

	console.log(`로컬 개발 서버 시작:
  ${cyan('bun run dev')}

프로덕션 배포:
  ${cyan('bun run deploy')}
  (배포 전 ${yellow('wrangler secret put IDP_SIGNING_KEY_SECRET')} 으로 시크릿을 설정하세요)
`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
	const argv = process.argv.slice(2);
	const args = parseArgs(argv);

	if (args.help) {
		printHelp();
		process.exit(0);
	}

	console.log(`${C.bold}${cyan('=== Keystone 프로젝트 셋업 ===')}${C.reset}`);

	// Step 0: wrangler login check
	const accountId = await step0_wranglerLogin(args);

	// Step 1: wrangler.jsonc
	await step1_createWranglerJsonc(args);

	// Step 2: .env
	await step2_createEnv(args);

	// Step 3: DB setup
	const { dbId, dbName, previewDbId, previewDbName } = await step3_dbSetup(args);

	// Step 4: Update files
	await step4_updateFiles(dbId, previewDbId, accountId);

	// Step 5: Migration
	await step5_migrate(args, previewDbId !== null, dbName, previewDbName);

	// Step 5b: Bootstrap admin directly in D1
	const adminResult = await step5b_bootstrapConfig(args, dbName, previewDbName);

	// Step 6: Signing key
	await step6_signingKey(args);

	// Done
	closeRL();
	printComplete(adminResult);
}

main().catch((err) => {
	console.error(red(`\n오류: ${err instanceof Error ? err.message : String(err)}`));
	closeRL();
	process.exit(1);
});
