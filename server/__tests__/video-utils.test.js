// QA-02: video_utils 行为测试（此前仅静态源码断言，覆盖率 5.4%）
// 覆盖：文件不存在短路、复用有效缩略图、spawn 成功落定 JPEG、半成品清理、
//       时长解析成功/非数值/失败。ffmpeg/ffprobe 路径用真实临时文件 mock。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const mockSpawn = jest.fn();
jest.mock('child_process', () => ({ spawn: mockSpawn, execSync: jest.fn() }));
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../logger', () => mockLogger);

// installer 路径指向真实的临时二进制文件（存在），这样 getFfmpegPaths 走 installer 分支
let fakeBinDir;
jest.mock('@ffmpeg-installer/ffmpeg', () => ({ get path() { return require('path').join(global.__fakeBinDir, 'ffmpeg.exe'); } }), { virtual: true });
jest.mock('@ffprobe-installer/ffprobe', () => ({ get path() { return require('path').join(global.__fakeBinDir, 'ffprobe.exe'); } }), { virtual: true });

let tmpDir;
let videoUtils;

class FakeChild extends EventEmitter {
  constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); }
  kill() {}
}
function validJpeg() { return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(200, 0x41)]); }
function invalidJpeg() { return Buffer.from([0x00, 0x01, 0x02, ...Buffer.alloc(200, 0x41)]); }
function mockSpawnWriteJpeg(content, code = 0) {
  mockSpawn.mockImplementation((bin, args) => {
    const child = new FakeChild();
    const outPath = args[args.length - 1];
    setTimeout(() => {
      if (content !== null) fs.writeFileSync(outPath, content);
      child.emit('close', code);
    }, 0);
    return child;
  });
}
function mockSpawnStdout(stdout, code = 0) {
  mockSpawn.mockImplementation(() => {
    const child = new FakeChild();
    setTimeout(() => { child.stdout.emit('data', Buffer.from(stdout)); child.emit('close', code); }, 0);
    return child;
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-utils-'));
  fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-bin-'));
  fs.writeFileSync(path.join(fakeBinDir, 'ffmpeg.exe'), 'fake');
  fs.writeFileSync(path.join(fakeBinDir, 'ffprobe.exe'), 'fake');
  global.__fakeBinDir = fakeBinDir;
  jest.resetModules();
  mockSpawn.mockReset();
  Object.values(mockLogger).forEach(m => m.mockClear());
  videoUtils = require('../video_utils');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(fakeBinDir, { recursive: true, force: true });
});

describe('video_utils 行为测试', () => {
  test('视频文件不存在 → extractVideoThumbnail 返回空、getVideoDuration 返回 0', async () => {
    const missing = path.join(tmpDir, 'nope.mp4');
    expect(await videoUtils.extractVideoThumbnail(missing, tmpDir)).toBe('');
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(await videoUtils.getVideoDuration(missing)).toBe(0);
  });

  test('spawn 成功写出有效 JPEG → 落定正式缩略图，临时文件消失', async () => {
    const video = path.join(tmpDir, 'clip.mp4');
    fs.writeFileSync(video, Buffer.alloc(2048, 0x62));
    mockSpawnWriteJpeg(validJpeg());
    const thumb = await videoUtils.extractVideoThumbnail(video, tmpDir);
    expect(thumb).toMatch(/^thumb_clip_[0-9a-f]{8}\.jpg$/);
    expect(fs.existsSync(path.join(tmpDir, thumb))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, thumb + '.tmp'))).toBe(false);
    // 第二次调用复用，不再 spawn
    mockSpawn.mockClear();
    expect(await videoUtils.extractVideoThumbnail(video, tmpDir)).toBe(thumb);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test('spawn 写出半成品（非 JPEG）→ 清理临时文件，返回空串', async () => {
    const video = path.join(tmpDir, 'bad.mp4');
    fs.writeFileSync(video, Buffer.alloc(500, 0x63));
    mockSpawnWriteJpeg(invalidJpeg());
    expect(await videoUtils.extractVideoThumbnail(video, tmpDir)).toBe('');
    expect(fs.readdirSync(tmpDir).filter(f => f.endsWith('.tmp'))).toHaveLength(0);
  });

  test('getVideoDuration：ffprobe 输出合法秒数 → 四舍五入整数', async () => {
    const video = path.join(tmpDir, 'dur.mp4');
    fs.writeFileSync(video, Buffer.alloc(100));
    mockSpawnStdout('12.6\n', 0);
    expect(await videoUtils.getVideoDuration(video)).toBe(13);
  });

  test('getVideoDuration：非数值 / 非零退出码 → 返回 0', async () => {
    const video = path.join(tmpDir, 'dur2.mp4');
    fs.writeFileSync(video, Buffer.alloc(100));
    mockSpawnStdout('N/A', 0);
    expect(await videoUtils.getVideoDuration(video)).toBe(0);
    mockSpawnStdout('9.9', 1);
    expect(await videoUtils.getVideoDuration(video)).toBe(0);
  });
});
