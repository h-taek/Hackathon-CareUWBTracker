import * as assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ENV_FILE_NAME, loadEnvFile } from '../../server/config/env-file.ts';

/** 실제 파일을 두고 확인한다. 경로 조립이 이 함수가 하는 일의 절반이다. */
function dirWith(contents: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envfile-'));
  if (contents !== null) fs.writeFileSync(path.join(dir, ENV_FILE_NAME), contents, 'utf8');
  return dir;
}

test('디렉터리 안의 .env를 읽어 경로를 돌려준다', () => {
  const dir = dirWith('CARE_ENVFILE_TEST_A=from_file\n');
  const loaded: string[] = [];

  const file = loadEnvFile(dir, { load: (f) => loaded.push(f) });

  assert.equal(file, path.join(dir, ENV_FILE_NAME));
  assert.deepEqual(loaded, [path.join(dir, ENV_FILE_NAME)]);
});

test('파일이 없으면 null을 주고 아무것도 하지 않는다', () => {
  // 기본 구성으로 띄우는 경우가 이쪽이다. 없다고 서버가 죽으면 안 된다
  // (process.loadEnvFile은 없는 파일에 ENOENT를 던진다).
  const dir = dirWith(null);
  let called = false;

  const file = loadEnvFile(dir, { load: () => { called = true; } });

  assert.equal(file, null);
  assert.equal(called, false, '없는 파일을 읽으려 들었다');
});

test('실제로 process.env에 실린다', () => {
  const dir = dirWith('CARE_ENVFILE_TEST_B=hello\n');
  try {
    loadEnvFile(dir);
    assert.equal(process.env.CARE_ENVFILE_TEST_B, 'hello');
  } finally {
    delete process.env.CARE_ENVFILE_TEST_B;
  }
});

test('셸에서 준 값이 파일보다 우선한다', () => {
  // 한 번만 다르게 띄울 때 파일을 고치지 않아도 되는 자리다.
  const dir = dirWith('CARE_ENVFILE_TEST_C=from_file\n');
  process.env.CARE_ENVFILE_TEST_C = 'from_shell';
  try {
    loadEnvFile(dir);
    assert.equal(process.env.CARE_ENVFILE_TEST_C, 'from_shell');
  } finally {
    delete process.env.CARE_ENVFILE_TEST_C;
  }
});
