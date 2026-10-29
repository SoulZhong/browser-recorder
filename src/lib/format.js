export function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 文件名用的时间戳：可排序、跨平台合法（冒号在 Windows/macOS 都不能进文件名）。 */
export function fmtStamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** 旧版默认标题自带 "YYYY-MM-DD HH:MM:SS" 后缀，拼文件名前去掉，避免出现两个时间戳。 */
const LEGACY_STAMP = /[\s_-]*\d{4}-\d{2}-\d{2}[\s_-]+\d{2}:\d{2}:\d{2}\s*$/;

/**
 * 把标题清洗成文件名主体。
 *
 * 空格一律换成下划线：带空格的文件名在命令行、脚本、URL 里都要额外加引号或转义，
 * 是持续的摩擦源。去掉文件系统保留字符和控制字符，去掉首尾的点（否则会变成隐藏文件），
 * 全空时退回一个通用名——绝不产出空文件名。
 */
export function safeFileName(title, fallback = '录制') {
  const base = String(title || '').replace(LEGACY_STAMP, '');
  const cleaned = base
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_')  // 保留字符与控制字符
    .replace(/\s+/g, '_')                      // 空白（含换行/制表）一律换成下划线
    .replace(/_{2,}/g, '_')                    // 连续下划线收成一个
    .replace(/^[._]+|[._]+$/g, '')             // 首尾的点/下划线剥掉
    .slice(0, 100)
    .replace(/[._]+$/, '');                    // 截断可能又切出尾部杂符
  return cleaned || fallback;
}

export function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 扩展徽标上的录制时长。
 * Chrome 徽标最多约 4 个字符可读，所以按量级分段，牺牲精度换清晰：
 *   < 10 分钟  M:SS   秒级，刚开录时最需要
 *   < 1 小时   MMm    分钟级
 *   >= 1 小时  HhMM   小时 + 分钟
 * 精确到秒的时间在弹窗里，徽标只负责"一眼扫到"。
 */
export function fmtBadge(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 600) {
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }
  if (total < 3600) return `${Math.floor(total / 60)}m`;
  const h = Math.floor(total / 3600);
  if (h >= 10) return `${h}h`;          // 两位小时数再带分钟就超过 4 字符了
  const m = Math.floor((total % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}`;
}
