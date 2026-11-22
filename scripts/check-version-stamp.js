#!/usr/bin/env node
/**
 * QA-06：前端改动必须升版本戳守卫（低风险、按需调用，不侵入既有构建流程）。
 *
 * 背景：
 *  · scripts/bump-version.js 只负责「改戳」，但漏调用时没有任何自动拦截；
 *  · server/__tests__/security-regressions.test.js（M5 两例）只校验「戳是否全站一致」，
 *    并不校验「前端文件改了是否升戳」——一致但未升的旧戳照样能通过。
 * 本脚本补上这条缺口：若 base 与当前工作区之间 public/ 有改动，则 public/index.html
 * 里的版本戳（?v=）必须相对 base 发生变化，否则以退出码 1 失败并提示执行 bump-version.js。
 *
 * 用法：
 *   node scripts/check-version-stamp.js [base-ref]
 *     base-ref 缺省为 HEAD~1（上一次提交）。
 *   本地提交前：
 *     node scripts/check-version-stamp.js HEAD~1
 *     （对比「上一次提交」与「当前工作区」，含未提交改动；
 *      git diff <base> -- public/ 天然覆盖已暂存/未暂存改动）
 *   CI / PR（需 checkout fetch-depth: 0，保证 base 对象可取）：
 *     PR：  node scripts/check-version-stamp.js "${{ github.event.pull_request.base.sha }}"
 *     push：node scripts/check-version-stamp.js "${{ github.event.before }}"
 *
 * 跳过（不误报）情形，退出码均为 0：
 *   · public/ 无改动；
 *   · base 为全 0（新分支/首次推送时 github.event.before 的形态）；
 *   · base 对象不可用（浅克隆/无效 sha）——打印告警后跳过，绝不因基础设施问题误红 CI。
 *
 * 退出码：0 = 通过或跳过；1 = 前端有改动但未升戳。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const PUB_REL = 'public';
const INDEX_REL = 'public/index.html';

function git(args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

// 提取 index.html 中所有 ?v= 戳，排序后拼成字符串用于对比。
// 与 security-regressions.test.js 的「全站单戳」约定兼容：单戳时即为该戳。
function stampsOf(text) {
  const out = new Set();
  const re = /\?v=([0-9A-Za-z]+)/g;
  let m;
  while ((m = re.exec(text))) out.add(m[1]);
  return Array.from(out).sort().join(',');
}

function skip(reason) {
  console.log('[version-stamp] 跳过守卫：' + reason);
}

function main() {
  const base = process.argv[2] || 'HEAD~1';

  // 全 0 sha：新分支/首次推送，没有可比基线 → 跳过，避免误报。
  if (/^0{40}$/.test(base)) {
    skip('base 为全 0（新分支/首次推送）');
    return;
  }

  // 1) 前端文件是否变化（base → 当前工作区，含未提交改动）
  let changed;
  try {
    changed = git(['diff', '--name-only', base, '--', PUB_REL]);
  } catch (e) {
    skip('无法对比 base=' + base + '（git 历史不足或 sha 无效）：' + String(e.message).split('\n')[0]);
    return;
  }
  if (!changed) {
    skip('public/ 无改动');
    return;
  }

  // 2) base 版本戳（git show）与当前工作区版本戳（fs）
  let baseStamp;
  try {
    baseStamp = stampsOf(git(['show', base + ':' + INDEX_REL]));
  } catch (e) {
    skip('无法读取 base 的 ' + INDEX_REL + '：' + String(e.message).split('\n')[0]);
    return;
  }
  const headStamp = stampsOf(fs.readFileSync(path.join(root, INDEX_REL), 'utf8'));

  // 3) 判定：有前端改动但戳未变化 → 失败
  if (baseStamp === headStamp) {
    const files = changed.split('\n').filter(Boolean);
    console.error('❌ 前端文件有改动，但版本戳未升（当前戳：' + (headStamp || '无') + '）。');
    console.error('改动的前端文件：\n  ' + files.join('\n  '));
    console.error('请执行：node scripts/bump-version.js  生成新戳并全站同步后重新提交。');
    process.exitCode = 1;
    return;
  }

  console.log('✅ 前端有改动且版本戳已升：' + (baseStamp || '无') + ' → ' + headStamp);
}

main();
