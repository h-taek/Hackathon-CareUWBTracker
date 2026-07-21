'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseHeader, parseRow, trialKey, groupTrials, EXPECTED } = require('./csv');

const HEADER = EXPECTED.join(',');

test('헤더를 컬럼 인덱스 맵으로 파싱한다', () => {
  const idx = parseHeader(HEADER);
  assert.equal(idx.dataset, 0);
  assert.equal(idx.smv_g, 11);
});

test('기대 컬럼이 없으면 던진다', () => {
  assert.throws(() => parseHeader('a,b,c'), /컬럼이 없습니다/);
});

test('데이터 행을 숫자로 파싱하고 is_fall을 불린으로 만든다', () => {
  const idx = parseHeader(HEADER);
  const r = parseRow('SisFall,SA01,waist,F01,R01,1,200,20.0,0.1,-0.98,0.05,0.986', idx);
  assert.equal(r.dataset, 'SisFall');
  assert.equal(r.placement, 'waist');
  assert.equal(r.isFall, true);
  assert.equal(r.tMs, 20);
  assert.equal(r.az, 0.05);
});

test('숫자가 깨진 행은 null', () => {
  const idx = parseHeader(HEADER);
  assert.equal(parseRow('SisFall,SA01,waist,F01,R01,1,200,NaN,x,y,z,w', idx), null);
});

test('연속 같은 키 행을 하나의 trial로 묶는다', () => {
  const idx = parseHeader(HEADER);
  const rows = [
    'SisFall,SA01,waist,D01,R01,0,200,0.0,0,0,1,1',
    'SisFall,SA01,waist,D01,R01,0,200,20.0,0,0,1,1',
    'SisFall,SA01,waist,F01,R01,1,200,0.0,0,0,1,1',
  ].map((l) => parseRow(l, idx));
  const trials = [...groupTrials(rows)];
  assert.equal(trials.length, 2);
  assert.equal(trials[0].samples.length, 2);
  assert.equal(trials[0].isFall, false);
  assert.equal(trials[1].isFall, true);
  assert.equal(trials[1].activity, 'F01');
});

test('trialKey는 5개 식별자를 결합한다', () => {
  const idx = parseHeader(HEADER);
  const r = parseRow('UCI-455,104,waist,901,Test_1,1,25,0.0,0,0,1,1', idx);
  assert.equal(trialKey(r), 'UCI-455|104|waist|901|Test_1');
});
