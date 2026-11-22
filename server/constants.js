/**
 * 境途同游 — 后端共享常量
 *
 * 仅集中语义明确、被散落引用的魔法值；不做行为重构。
 */

// 密码重置验证码：8 位十进制数字，crypto.randomInt 区间为 [MIN, MAX)。
const PASSWORD_RESET_CODE_MIN = 10000000;
const PASSWORD_RESET_CODE_MAX_EXCLUSIVE = 100000000;

// 密码重置验证码 / token 有效期：15 分钟。
const PASSWORD_RESET_CODE_TTL_MS = 15 * 60 * 1000;

// 成就解锁条件类型（对应 achievements.condition_type 枚举）。
const ACHIEVEMENT_CONDITION_STREAK = 'streak';
const ACHIEVEMENT_CONDITION_TOTAL = 'total';

module.exports = {
  PASSWORD_RESET_CODE_MIN,
  PASSWORD_RESET_CODE_MAX_EXCLUSIVE,
  PASSWORD_RESET_CODE_TTL_MS,
  ACHIEVEMENT_CONDITION_STREAK,
  ACHIEVEMENT_CONDITION_TOTAL
};
