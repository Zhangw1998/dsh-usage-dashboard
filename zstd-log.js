/**
 * 多帧 Zstandard 会话日志解码器。
 *
 * 为什么不能直接用 `zlib.zstdDecompressSync`：
 * DSH 的会话日志是**追加写入的多帧 zstd 流**（每个持久化批次一帧，带 checksum），
 * 而 Node 的一次性 API `zstdDecompressSync` 只解**第一帧**就返回，
 * 于是「日志里有几万个事件，却只读出 1 行」。
 *
 * 这里移植 @deepseek-ai/dsh-session-persistence-jsonl 的帧扫描算法
 * （scanZstdFrames）：不依赖私有 API，只按 zstd 帧头格式在字节流上定位每帧边界，
 * 再逐帧调用公开的 `zstdDecompressSync`。这样与 DSH 自己的读取行为一致，
 * 且只使用公开 API。
 *
 * 日志正在被写入时，最后一帧可能是残缺的（tornStart）：按 DSH 的做法只解完整帧，
 * 残缺尾部留给下一次扫描。
 */
import { zstdDecompressSync } from 'node:zlib'

/** zstd 帧的魔数（小端 0xFD2FB528）。 */
const ZSTD_MAGIC = 4247762216

/**
 * 在字节流上定位所有完整 zstd 帧的边界，不触碰压缩块内容。
 * @param buffer - 会话文件当前的全部字节。
 * @returns { frames: [{start, end}], tornStart?: number }，tornStart 表示尾部残缺帧的起点。
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * 解压一个多帧 zstd 会话日志。
 * @param buffer - 会话文件的完整字节。
 * @returns 解码后的 UTF-8 文本；残缺尾帧被忽略。
 */
export function decodeSessionLog(buffer) {
  const { frames } = scanZstdFrames(buffer)
  const parts = []
  for (const frame of frames) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
    } catch {
      // 单帧损坏不应让整个会话不可读：跳过该帧继续
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * 解压并逐行解析事件。
 * @param buffer - 会话文件的完整字节。
 * @returns 事件对象数组；解析失败的行（含写入中的残行）被跳过。
 */
export function readSessionEvents(buffer) {
  const text = decodeSessionLog(buffer)
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // 写入中的残行
    }
  }
  return events
}
