/**
 * gRPC-Web Text 响应解析器
 *
 * 响应格式（双层 base64）：
 *   原始字符串
 *     └─ base64 解码
 *          └─ ASCII 文本，由两段 base64 拼接而成：
 *               ├─ 数据帧 base64：解码后 = [5字节帧头 + protobuf payload]
 *               └─ trailer 帧 base64：解码后 = [5字节帧头(0x80) + "grpc-status:0\r\n"]
 *
 * Content-Type: application/grpc-web-text+proto
 */

export interface ProtobufFields {
  [fieldNumber: number]: ProtobufValue | ProtobufValue[];
}

export type ProtobufValue = string | number | Uint8Array;

export interface GrpcWebParseResult {
  grpcStatus: number | null;
  trailers: string;
  dataFlags: string;
  protobufHex: string;
  protobufRaw: Uint8Array;
  fields: ProtobufFields;
}

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

/** 容忍 padding 缺失的 base64 解码，返回 Uint8Array */
export function safeBase64Decode(s: string): Uint8Array {
  const trimmed = s.trim();
  // 清理非 base64 字符（保留 A-Z, a-z, 0-9, +, /, =）
  const cleaned = trimmed.replace(/[^A-Za-z0-9+/=]/g, '');
  if (!cleaned) {
    throw new Error('输入不包含有效的 base64 字符');
  }
  // 移除已有的 padding，然后重新添加正确的 padding
  const withoutPadding = cleaned.replace(/=+$/, '');
  const paddingNeeded = (4 - (withoutPadding.length % 4)) % 4;
  const padded = withoutPadding + '='.repeat(paddingNeeded);
  
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch (e) {
    // 提供更详细的错误信息用于调试
    const preview = padded.length > 100 ? `${padded.slice(0, 50)}...${padded.slice(-50)}` : padded;
    throw new Error(
      `Base64 解码失败。字符串长度：${padded.length}，预览：${preview}。原始错误：${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/** 解析单个 gRPC-Web 帧，返回 { flags, payload } */
export function parseGrpcFrame(frameBytes: Uint8Array): { flags: number; payload: Uint8Array } {
  if (frameBytes.length < 5) {
    throw new Error(`帧太短：${frameBytes.length} 字节，至少需要 5 字节帧头`);
  }
  const flags = frameBytes[0];
  // big-endian uint32
  const length =
    (frameBytes[1] << 24) | (frameBytes[2] << 16) | (frameBytes[3] << 8) | frameBytes[4];
  const payload = frameBytes.slice(5, 5 + length);
  return { flags, payload };
}

/**
 * 手动解析 protobuf 字节，不依赖 .proto 文件。
 * 支持 wire type：varint(0)、64-bit(1)、length-delimited(2)、32-bit(5)
 */
export function decodeProtobufFields(data: Uint8Array): ProtobufFields {
  const fields: ProtobufFields = {};
  let offset = 0;

  function readVarint(): number {
    let result = 0;
    let shift = 0;
    while (offset < data.length) {
      const b = data[offset++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  }

  function addField(fieldNum: number, value: ProtobufValue) {
    if (fieldNum in fields) {
      const existing = fields[fieldNum];
      if (Array.isArray(existing)) {
        (existing as ProtobufValue[]).push(value);
      } else {
        fields[fieldNum] = [existing as ProtobufValue, value];
      }
    } else {
      fields[fieldNum] = value;
    }
  }

  while (offset < data.length) {
    const tag = readVarint();
    const fieldNum = tag >> 3;
    const wtype = tag & 0x07;

    if (wtype === 0) {
      // varint
      const value = readVarint();
      addField(fieldNum, value);
    } else if (wtype === 1) {
      // 64-bit
      const value = data.slice(offset, offset + 8);
      offset += 8;
      addField(fieldNum, value);
    } else if (wtype === 2) {
      // length-delimited: 始终保留原始字节，延迟到展示层决定如何呈现
      const length = Number(readVarint());
      const raw = data.slice(offset, offset + length);
      offset += length;
      addField(fieldNum, raw);
    } else if (wtype === 5) {
      // 32-bit
      const value = data.slice(offset, offset + 4);
      offset += 4;
      addField(fieldNum, value);
    } else {
      // 未知 wire type，停止解析
      break;
    }
  }

  return fields;
}

/** Uint8Array 转 hex 字符串 */
export function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─────────────────────────────────────────────
// 主解析函数
// ─────────────────────────────────────────────

/**
 * 解析 application/grpc-web-text+proto 响应。
 *
 * @param b64String 完整的 base64 字符串（或 data:... URI 格式）
 */
export function parseGrpcWebText(b64String: string): GrpcWebParseResult {
  try {
    const b64 = extractBase64FromInput(b64String);

    // ── 第一层解码：整体 base64 → ASCII 文本 ──
    let layer1Bytes: Uint8Array;
    try {
      layer1Bytes = safeBase64Decode(b64);
    } catch (e) {
      throw new Error(`第一层 base64 解码失败：${e instanceof Error ? e.message : String(e)}`);
    }
    const layer1Text = new TextDecoder('ascii').decode(layer1Bytes);

    // ── 拆分数据帧 b64 和 trailer 帧 b64 ──
    // trailer 帧 base64 首字符是 'g'（0x80 对应的 base64 首字节）
    // 使用 lastIndexOf 因为 trailer 总是在最后，避免数据帧中也出现 'gAAAA'
    const trailerMarker = 'gAAAA';
    const splitPos = layer1Text.lastIndexOf(trailerMarker);
    if (splitPos === -1) {
      throw new Error(`找不到 trailer 标记 '${trailerMarker}'，响应格式可能不同`);
    }

    const dataB64Str = layer1Text.slice(0, splitPos);
    const trailerB64Str = layer1Text.slice(splitPos);

    // ── 第二层解码：数据帧 ──
    let dataFrameBytes: Uint8Array;
    try {
      dataFrameBytes = safeBase64Decode(dataB64Str);
    } catch (e) {
      throw new Error(`数据帧 base64 解码失败（长度 ${dataB64Str.length}）：${e instanceof Error ? e.message : String(e)}`);
    }
    const { flags: dataFlags, payload: dataPayload } = parseGrpcFrame(dataFrameBytes);

    // ── 第二层解码：trailer 帧 ──
    let trailerFrameBytes: Uint8Array;
    try {
      trailerFrameBytes = safeBase64Decode(trailerB64Str);
    } catch (e) {
      throw new Error(`Trailer 帧 base64 解码失败（长度 ${trailerB64Str.length}）：${e instanceof Error ? e.message : String(e)}`);
    }
    const { payload: trailerPayload } = parseGrpcFrame(trailerFrameBytes);
    const trailerText = new TextDecoder('utf-8').decode(trailerPayload).trim();

    // 提取 grpc-status
    let grpcStatus: number | null = null;
    for (const line of trailerText.split(/\r?\n/)) {
      if (line.toLowerCase().startsWith('grpc-status:')) {
        const val = parseInt(line.split(':', 2)[1].trim(), 10);
        if (!isNaN(val)) grpcStatus = val;
      }
    }

    // ── 解析 protobuf payload ──
    const fields = decodeProtobufFields(dataPayload);

    return {
      grpcStatus,
      trailers: trailerText,
      dataFlags: `0x${dataFlags.toString(16).padStart(2, '0')}`,
      protobufHex: uint8ArrayToHex(dataPayload),
      protobufRaw: dataPayload,
      fields,
    };
  } catch (e) {
    // 确保所有错误都有清晰的上下文
    if (e instanceof Error && e.message.includes('base64')) {
      throw e; // 已经有详细的 base64 错误信息
    }
    throw new Error(`gRPC-Web 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────

/**
 * 从各种格式输入中提取 base64 字符串：
 *   - data:application/grpc-web-text+proto;base64,<b64>
 *   - 纯 base64 字符串
 */
export function extractBase64FromInput(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (trimmed.startsWith('data:')) {
    const commaIdx = trimmed.lastIndexOf(',');
    return commaIdx !== -1 ? trimmed.slice(commaIdx + 1).trim() : trimmed;
  }
  return trimmed;
}

export function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * 判断字节数组是否"看起来像"一个合法的 protobuf 消息：
 * 尝试解析，成功且至少有一个字段则认为是嵌套消息。
 */
function looksLikeProto(raw: Uint8Array): boolean {
  if (raw.length < 2) return false;
  try {
    const fields = decodeProtobufFields(raw);
    return Object.keys(fields).length > 0;
  } catch {
    return false;
  }
}

/**
 * 判断字节是否全部为可打印字符（无控制字符）。
 * 允许：printable ASCII (0x20-0x7E)、换行、制表、常见 Unicode。
 */
function isPrintableUtf8(raw: Uint8Array): boolean {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    // 拒绝含 C0/C1 控制字符（0x00-0x1F 排除 \t \n \r，以及 0x7F DEL）
    return !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text);
  } catch {
    return false;
  }
}

/**
 * 把单个 Uint8Array 字段值转为 JSON 友好的值（递归）。
 *
 * 优先级：
 *   1. 可打印 UTF-8 → 直接返回字符串
 *      （真正的嵌套 proto 一定含有控制字符作为 tag/length 字节，不可能全是可打印字符）
 *   2. 含控制字符 + looksLikeProto → 递归展开嵌套消息
 *   3. 降级为 0x... hex 字符串
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bytesToJsonValue(raw: Uint8Array, depth: number): any {
  if (isPrintableUtf8(raw)) {
    return new TextDecoder('utf-8').decode(raw);
  }
  if (depth < 6 && looksLikeProto(raw)) {
    return fieldsToJsonObject(raw, depth + 1);
  }
  return `0x${uint8ArrayToHex(raw)}`;
}

/**
 * 把 ProtobufFields 递归转为纯 JSON 可序列化对象。
 * - varint / 32-bit / 64-bit  → number（或 hex 字符串）
 * - length-delimited           → 递归尝试嵌套消息 → 可打印字符串 → hex
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fieldsToJsonObject(data: Uint8Array, depth = 0): Record<string, any> {
  const fields = decodeProtobufFields(data);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Record<string, any> = {};

  for (const [key, raw] of Object.entries(fields)) {
    const vals = Array.isArray(raw) ? (raw as ProtobufValue[]) : [raw as ProtobufValue];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: any[] = vals.map((v) => {
      if (v instanceof Uint8Array) return bytesToJsonValue(v, depth);
      // varint / number
      return v;
    });
    out[`field_${key}`] = mapped.length === 1 ? mapped[0] : mapped;
  }

  return out;
}
