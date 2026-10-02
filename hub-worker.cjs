#!/usr/bin/env node
/**
 * hub-worker.cjs — 统一 worker：产品报告 + 5 个生图场景（替代 6 个 Make 场景）
 *
 * 场景与来源蓝图（提示词/模型/字段 1:1 复刻，存于 _bp_prompts.json）：
 *   产品报告生成     tblxcPYWrYlI7yjC  → 复用 report-worker.cjs 的 processRecord
 *   主图生成         tblPQa2zYuN3yYAw  ← Make 场景 5617647（main）
 *   主图修图         tblPQa2zYuN3yYAw  ← Make 场景 4673061（xiutu，nano-banana 双图修图）
 *   详情图生成       tblEg52tCy0qEC30  ← Make 场景 5628728（detail，gemini-3.1-flash-image）
 *   多角度细节图     tbl2Tz2nNa35ILhC  ← Make 场景 7504625（angles，8 屏子记录）
 *   模特+产品图      tblm8T1izOTSyoyh  ← Make 场景 7501276（model，双图 3:4）
 *
 * 与 Make 的差异（有意为之）：
 *   ① 触发改为轮询飞书（认领=写【系统】触发标记），webhook /run 即时点火兜底
 *   ② 图片不传 Cloudinary，base64 data URI 直塞模型
 *   ③ 主图/详情图/多角度的成图聚合写回【主记录】输出字段（Make 只写子记录，
 *      平台轮询主记录拿不到结果 → 平台侧必然 15 分钟超时，属 Make 版隐藏缺陷）
 *   ④ 失败状态统一写成含「失败」二字（平台按状态字段含"失败/fail"判失败，Make 的
 *      「🚨生图出错」等文案平台不认识，会干等 15 分钟）
 *   ⑤ 修图用 token-zone 的 gemini-3-pro-image-preview 复刻 nano-banana（双图+指令）
 *
 * 用法:
 *   node hub-worker.cjs --once   # 每张表最多处理 1 条后退出（测试用）
 *   node hub-worker.cjs --loop   # 常驻轮询（服务器部署用）
 * 依赖: 仅 Node.js >= 18（原生 fetch/FormData/Blob），零 npm 依赖
 */

'use strict'
const fs = require('fs')
const path = require('path')
const http = require('http')
const REPORT = require('./report-worker.cjs')

// ---------- 配置 ----------
const ENV_PATH = path.join(__dirname, '.env')
if (!fs.existsSync(ENV_PATH)) {
  console.error('[fatal] 缺少 .env 文件（参考 .env.example）')
  process.exit(1)
}
const env = Object.fromEntries(
  fs.readFileSync(ENV_PATH, 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Za-z_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()] })
)

const FEISHU_BASE = 'https://open.feishu.cn/open-apis'
const APP_TOKEN = env.APP_TOKEN
const LLM_BASE = (env.LLM_BASE_URL || '').replace(/\/$/, '')
const IMAGE_BASE = LLM_BASE.replace(/\/v1$/, '') + '/v1beta'   // generateContent 端点前缀
const LLM_KEY = env.LLM_API_KEY
const POLL_INTERVAL_MS = Number(env.POLL_INTERVAL_MS || 15000)
const LLM_TIMEOUT_MS = Number(env.LLM_TIMEOUT_MS || 480000)
const REPORT_TABLE_ID = env.TABLE_ID   // 报告表（兼容 report-worker 配置）

const PROMPTS = JSON.parse(fs.readFileSync(path.join(__dirname, '_bp_prompts.json'), 'utf8'))
// IP产品电商图生成专用提示词（同一框架，可爱/治愈/潮流倾向，见 prompts_ip/）
const PROMPTS_IP = JSON.parse(fs.readFileSync(path.join(__dirname, '_bp_prompts_ip.json'), 'utf8'))

// ---------- 表与字段常量 ----------
// 「套件」概念：同一套 worker 逻辑跑两套表 + 两套提示词。
//   core = 手机壳电商图生成（原链路，零改动）
//   ip   = IP产品电商图生成（潮玩/盲盒/文创，可爱·治愈·潮流倾向）
const T = {
  report: REPORT_TABLE_ID,
  mainImg: 'tblPQa2zYuN3yYAw',
  detail: 'tblEg52tCy0qEC30',
  angles: 'tbl2Tz2nNa35ILhC',
  model: 'tblm8T1izOTSyoyh',
  cutout: 'tbluHfW8G2N6nrBw', // AI抠图/生图（原 Make 场景已弃用，worker 直连网关生图）
}
const T_IP = {
  report: 'tblHL210rRftTPQj',   // IP产品报告生成
  angles: 'tblV3BmqL3i9xJf9',   // IP多角度细节图生成
  model: 'tblQ8X4witsdmiFA',    // IP模特+产品图生成
  mainImg: 'tblLlSyOSKmQrD3e',  // IP主图生成
  detail: 'tbls7xM34o4NwOwE',   // IP详情图生成
  series: 'tbl2IBx8rktxSzJ6',   // IP系列合集图生成（多款同框）
}
const TABLE_LIST = [T.report, T.mainImg, T.detail, T.angles, T.model, T.cutout, ...Object.values(T_IP)]

const F = {
  claim: '【系统】触发标记',
  // mainImg 表
  statusMain: '【状态】',
  countMain: '需要图片数',
  langMain: '【人工】语言选择',
  nameMain: '【输入】产品名称',
  imgMain: '【上传】产品白底参考图',
  outMain: '【AI】主图生成',
  promptMainChild: '【AI】主图生成提示词',
  editReq: '【人工】填写要修改的要求',
  replaceImg: '【人工】需要替换的图片',
  outXiutu: '【AI】完成修改的主图',
  // detail 表
  statusDetail: '【状态】',
  countDetail: '需要数量',
  langDetail: '【人工】语言选择',
  nameDetail: '【输入】产品名称',
  colorDetail: '【输入】产品颜色',
  pointsDetail: '【输入】产品亮点',
  paramsDetail: '【输入】产品参数',
  refDetail: '【上传】主参考图',
  outDetail: '【AI】详情图',
  promptDetailChild: '【AI】详情图生图提示词',
  // angles 表（字段名无括号，与飞书表实际一致）
  statusAngles: '状态',
  angleAngles: '角度',
  imgAngles: '【上传】产品基础图片',
  outAngles: 'AI生图',
  // angles 新 8 角度入口（旧列【上传】产品基础图片保留兼容）
  imgAnglesFront: '【上传】正面图',
  imgAnglesBack: '【上传】背面图',
  imgAnglesLeft: '【上传】左侧图',
  imgAnglesRight: '【上传】右侧图',
  imgAnglesTop: '【上传】顶部图',
  imgAnglesBottom: '【上传】底部图',
  imgAnglesExpand: '【上传】展开图',
  imgAnglesOther: '【上传】其他角度图',
  multiAngles: '【输入】指定角度',
  countAngles: '【输入】每组张数',
  // model 表
  statusModel: '【状态】',
  countModel: '需要图片数',
  countryModel: '【选择】国家',
  genderModel: '【选择】性别',
  descModel: '【输入】动作描述',
  nameModel: '【输入】产品名称',
  imgModel: '【上传】产品白底图',
  poseModel: '【上传】动作参考图',
  outModel: '【AI】图片',
  promptModel: '【AI】生成提示词',
  // 新版平台引用：报告全文文本字段（平台按编号解析后写入）+ 用户取消标记
  reportText: '【引用】产品报告内容',
  cancelFlag: '【系统】取消标记',
  // cutout 表
  statusCutout: '【状态】',
  outCutout: '【AI】结果图',
  // series 表（IP系列合集图生成，仅 IP 套件）
  statusSeries: '【状态】',
  nameSeries: '【输入】系列名称',
  imgSeries: '【上传】各款产品图',
  stylesSeries: '【输入】款式说明',
  layoutSeries: '【输入】构图要求',
  outSeries: '【AI】系列合集图',
  promptSeriesChild: '【AI】合集图生成提示词',
  // STEP4 主图 / STEP5 详情表的「产品合集图数量」（数字；0/空=全部单款，N>0 则前 N 张为多款合集图）
  seriesCount: '【输入】产品合集图数量',
}
const LOOKUP_REPORT = '产品报告引用'

// detail 六角度：角度标记 → 表字段
const DETAIL_ANGLES = [
  ['front', '【上传】正面图'],
  ['back', '【上传】背面图'],
  ['left', '【上传】左侧图'],
  ['right', '【上传】右侧图'],
  ['top', '【上传】顶部图'],
  ['bottom', '【上传】底部图'],
  ['expand', '【上传】展开图'],
  ['folded', '【上传】折叠/变形后图'],
]
const DETAIL_ANGLE_CN = { front: '正面', back: '背面', left: '左侧', right: '右侧', top: '顶部', bottom: '底部', expand: '展开', folded: '折叠' }
// detail 参考图兜底顺序（与 Make switch/ifempty 链一致，展开/折叠图追加为兜底）
const DETAIL_FALLBACK = ['front', 'back', 'left', 'right', 'top', 'bottom', 'expand', 'folded']

// angles 8 角度入口：中文角度名 → 表字段（顺序即默认生成顺序）
const ANGLE_FIELDS = [
  ['正面', '【上传】正面图'],
  ['背面', '【上传】背面图'],
  ['左侧', '【上传】左侧图'],
  ['右侧', '【上传】右侧图'],
  ['顶部', '【上传】顶部图'],
  ['底部', '【上传】底部图'],
  ['展开', '【上传】展开图'],
  ['其他', '【上传】其他角度图'],
]

// detail code63 的参考图指令（原样）
const DETAIL_REF_INSTRUCTION = "\n\n参考图可能是同一产品的其他角度。必须严格保持参考图中的产品结构、材质、颜色、LOGO、位置、比例和细节一致。如果参考图视角与目标画面角度不同，请根据参考图推导目标角度，只改变观察角度，不要重新设计产品，不要改变包装和外观。"
// angles code177 的提示词后缀（原样）
// core = 手机壳版（保留原句）；ip = IP 版：约束同款，质感要求改成「柔和治愈」而不是「干净高级」
const ANGLES_SUFFIX = {
  core: '，严格参考上传的产品图，保持产品的造型、比例、颜色、材质、图案、Logo与关键细节一致，可以优化背景、构图、光影和商业质感，但不能重新设计产品，不得增加不存在的功能、结构、配件或赠品，画面中禁止出现任何标题、字幕、水印、图标、边框和促销标签，仅保留产品自身原有的图案与文字，高清商业摄影质感，构图干净高级，光影真实自然，产品主体清晰，画面比例1:1',
  ip: '，严格参考上传的产品图，保持角色的造型、比例、颜色、材质、涂装、图案、Logo与关键细节一致，不得改脸、不得换配色、不得重画角色，不得增加不存在的配件、赠品或背景道具，只允许调整背景、构图、光影与氛围，画面中禁止出现任何标题、字幕、水印、图标、边框和促销标签，仅保留产品自身原有的图案与文字，柔和散射光，轻奶油色调，画面干净治愈可爱，产品主体清晰突出，画面比例1:1',
}

// 模型（与 Make 蓝图一致）
const MODEL_PROMPT_GEN = 'gpt-5.6-luna'                // 提示词生成（各场景 chat；gemini-3.5 已被网关下线）
const MODEL_IMG_PRO = 'gemini-3-pro-image-preview'     // 生图（angles/main/model/xiutu）
const MODEL_IMG_DETAIL = 'gemini-3.1-flash-image'      // 生图（detail 专用）

// 套件表：core=手机壳系列（原链路，零改动） / ip=IP产品电商图生成（潮玩·盲盒·文创）
const SUITES = {
  core: { key: 'core', label: '手机壳', T, P: PROMPTS, angleSuffix: ANGLES_SUFFIX.core },
  ip: { key: 'ip', label: 'IP', T: T_IP, P: PROMPTS_IP, angleSuffix: ANGLES_SUFFIX.ip },
}
// 表 ID → 套件；查不到按 core 处理（旧数据兜底）
const SUITE_OF = {}
for (const [k, tbl] of Object.entries({ core: T, ip: T_IP })) {
  for (const tid of Object.values(tbl)) if (tid) SUITE_OF[tid] = SUITES[k]
}
const suiteOf = (tableId) => SUITE_OF[tableId] || SUITES.core

// 页面「生图大模型」选择卡：平台把「实际模型名@@裸URL」写进【输入】生图模型，worker 按其覆盖默认生图模型
const FIELD_GEN_MODEL = '【输入】生图模型'
function pickGenModel(fields) {
  const raw = textOf(fields[FIELD_GEN_MODEL]).trim()
  if (!raw || !raw.includes('@@')) return null
  const [name, base] = raw.split('@@')
  if (!name) return null
  return { name: name.trim(), base: (base || '').replace(/\/+$/, '') } // base 为裸域名（无 /v1）
}

// 页面「图片比例」下拉：平台把所选比例写进【输入】图片比例（STEP3/4/5 表同名字段），非法值回退各表默认
const FIELD_ASPECT = '【输入】图片比例'
const ASPECT_SET = new Set(['1:1', '3:4', '16:9'])
function pickAspect(fields, fallback) {
  const v = textOf(fields[FIELD_ASPECT]).trim()
  return ASPECT_SET.has(v) ? v : fallback
}

// 跨视角硬约束：多张同产品参考图时注入，防止生图/规划模型对不可见区域（按常识脑补）
// 括号里的「易被脑补部位」按品类区分：core=手机壳口径，ip=潮玩/衍生品口径
const CROSS_PART = {
  core: '（包括镜头开孔区的形状与布局、镜头数量与排列、闪光灯/传感器开孔、Logo、接口与按键位置）',
  ip: '（包括角色的五官排布与表情、配色分区、发型与服饰结构、配件与挂件位置、Logo 与吊牌）',
}
function crossNoteOf(S, n, target) {
  if (n < 2) return ''
  return `\n\n重要约束：随提示词附带的 ${n} 张图片是同一产品的不同视角实拍图${target ? `，本次目标画面为「${target}」视角` : ''}。这些参考图共同定义该产品的唯一外观：目标视角下不可见或被遮挡的区域${CROSS_PART[S.key]}，必须与显示该区域最清晰的参考图逐点一致——形状、数量、位置、比例、颜色完全复刻，禁止依据常识或同类产品重新设计；只能改变观察角度、光影与构图，不能重新设计产品的任何特征。若参考图之间出现同一区域的差异，以显示该区域最清晰、最完整的一张为准。`
}

// ---------- 工具 ----------
const log = (...a) => console.log(new Date().toISOString(), '|', ...a)

function textOf(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map((s) => (s && typeof s === 'object' && 'text' in s ? String(s.text) : String(s))).join('')
  return String(v)
}

// lookup 字段拍平取显示文本（兼容 [{text}] 与 [{value:{...text}}] 两种结构）
function lookupText(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    const direct = v.map((s) => (s && typeof s === 'object' && s.text != null ? String(s.text) : '')).filter(Boolean).join('\n')
    if (direct) return direct
    const parts = []
    for (const s of v) {
      if (s && typeof s === 'object' && s.value) {
        const inner = lookupText(s.value)
        if (inner) parts.push(inner)
      }
    }
    return parts.join('\n')
  }
  if (typeof v === 'object' && v.text != null) return String(v.text)
  return String(v)
}

// 附件字段取第一个附件（file_token/name/type）
function attFirst(fields, name) {
  const a = fields[name]
  if (Array.isArray(a) && a[0] && a[0].file_token) return a[0]
  return null
}

// 附件字段取全部附件（多图字段：产品图引用批次/多角度上传等）
function attAll(fields, name) {
  const a = fields[name]
  return Array.isArray(a) ? a.filter((x) => x && x.file_token) : []
}

// Make 占位符替换（占位符含 $ 与反引号，用 split/join 避免正则特殊符问题）
function fill(tpl, map) {
  let out = tpl
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v)
  return out
}

const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

// ---------- 飞书基础操作 ----------
let _tk = null
let _tkExp = 0
async function tenantToken() {
  const now = Date.now()
  if (_tk && now < _tkExp) return _tk
  const res = await fetch(FEISHU_BASE + '/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  })
  const j = await res.json()
  if (!j.tenant_access_token) throw new Error('获取 tenant_token 失败: ' + JSON.stringify(j).slice(0, 200))
  _tk = j.tenant_access_token
  _tkExp = now + (Math.max(j.expire - 300, 600)) * 1000
  return _tk
}

async function feishu(pathname, init) {
  const token = await tenantToken()
  const res = await fetch(FEISHU_BASE + pathname, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, ...(init && init.headers ? init.headers : {}) },
  })
  return res
}

async function listRecords(tableId) {
  const items = []
  let pageToken = ''
  do {
    const q = new URLSearchParams({ page_size: '50' })
    if (pageToken) q.set('page_token', pageToken)
    const res = await feishu(`/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?` + q.toString())
    const j = await res.json()
    if (j.code !== 0) throw new Error('列出记录失败: ' + j.code + ' ' + j.msg)
    items.push(...(j.data.items || []))
    pageToken = j.data.has_more ? j.data.page_token : ''
  } while (pageToken)
  return items
}

async function getRecord(tableId, recordId) {
  const res = await feishu(`/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/${recordId}`)
  const j = await res.json()
  if (j.code !== 0) throw new Error('读取记录失败: ' + j.code + ' ' + j.msg)
  return j.data.record.fields
}

async function updateRecord(tableId, recordId, fields) {
  const res = await feishu(`/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/${recordId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  const j = await res.json()
  if (j.code !== 0) throw new Error('更新记录失败: ' + j.code + ' ' + j.msg)
  return true
}

async function addRecord(tableId, fields) {
  const res = await feishu(`/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  const j = await res.json()
  if (j.code !== 0) throw new Error('新建记录失败: ' + j.code + ' ' + j.msg)
  return j.data.record.record_id
}

async function downloadMedia(fileToken) {
  const res = await feishu(`/drive/v1/medias/${fileToken}/download`)
  if (!res.ok) throw new Error('下载飞书附件失败: HTTP ' + res.status + ' token=' + fileToken)
  return Buffer.from(await res.arrayBuffer())
}

// 上传图片到多维表格（bitable_image），返回 file_token
async function uploadBitableImage(fileName, buf, mime) {
  const form = new FormData()
  form.append('file_name', fileName)
  form.append('parent_type', 'bitable_image')
  form.append('parent_node', APP_TOKEN)
  form.append('size', String(buf.byteLength))
  form.append('file', new Blob([new Uint8Array(buf)], { type: mime }), fileName)
  const token = await tenantToken()
  const res = await fetch(FEISHU_BASE + '/drive/v1/medias/upload_all', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
    body: form,
  })
  const j = await res.json()
  if (j.code !== 0) throw new Error('上传飞书附件失败: ' + j.code + ' ' + j.msg)
  return j.data.file_token
}

// ---------- 模型调用 ----------
// OpenAI 兼容 chat/completions（提示词生成）
async function chat(model, temperature, content) {
  const res = await fetch(LLM_BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + LLM_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`模型 ${model} HTTP ${res.status}: ` + (await res.text()).slice(0, 300))
  const j = await res.json()
  const msg = j.choices && j.choices[0] && j.choices[0].message
  if (!msg) throw new Error(`模型 ${model} 返回无 choices: ` + JSON.stringify(j).slice(0, 300))
  return typeof msg.content === 'string' ? msg.content : String(msg.content ?? '')
}

// Gemini generateContent 生图，返回 { b64, mime, buf }；baseOverride 传裸域名时用其 v1beta 端点（页面选定的模型平台）
async function geminiImage(model, body, baseOverride) {
  const base = baseOverride ? baseOverride.replace(/\/v1$/, '') + '/v1beta' : IMAGE_BASE
  const res = await fetch(`${base}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + LLM_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`生图 ${model} HTTP ${res.status}: ` + (await res.text()).slice(0, 300))
  const j = await res.json()
  const parts = (j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []
  const p = parts.find((x) => x.inlineData && x.inlineData.data)
  if (!p) throw new Error(`生图 ${model} 无图片返回: ` + JSON.stringify(j).slice(0, 300))
  const b64 = p.inlineData.data
  const mime = p.inlineData.mimeType || 'image/png'
  return { b64, mime, buf: Buffer.from(b64, 'base64') }
}

// 提示词通用后处理：@@@ 分块（Make: regexp @@@([\s\S]*) → split）
function splitBlocks(raw, maxCount) {
  const m = String(raw || '').match(/@@@([\s\S]*)/)
  if (!m) throw new Error('提示词输出里没有 @@@ 分块: ' + String(raw).slice(0, 120))
  let blocks = m[1].split('@@@').map((s) => s.trim()).filter((s) => s.length > 10)
  if (maxCount) blocks = blocks.slice(0, maxCount)
  if (!blocks.length) throw new Error('提示词分块为空')
  return blocks
}

// ---------- 用户取消：平台「停止」按钮把任务标失败并写【系统】取消标记，worker 在各阶段检查到后中止 ----------
async function isCancelled(tableId, recordId) {
  try {
    const f = await getRecord(tableId, recordId)
    return textOf(f[F.cancelFlag]).trim() !== ''
  } catch { return false }
}

// 检查取消标记：已取消则写停止状态并返回 true（调用方直接 return 中止，不再占用生图资源）
async function stopIfCancelled(tableId, recordId, statusField) {
  if (!(await isCancelled(tableId, recordId))) return false
  try { await updateRecord(tableId, recordId, { [statusField]: '⏹已停止（用户取消）' }) } catch {}
  log(`⏹ [${tableId}] ${recordId} 用户已取消，中止处理`)
  return true
}

// ---------- 场景 1：主图生成（tblPQa2zYuN3yYAw，复刻 Make 5617647 route2） ----------
async function mainImgHandler(item, S) {
  const recordId = item.record_id
  const t0 = Date.now()
  const fields = await getRecord(S.T.mainImg, recordId)
  if (await stopIfCancelled(S.T.mainImg, recordId, F.statusMain)) return

  // 产品图支持多张（直接上传多张或引用历史批次，平台层已转成多附件）
  const imgAtts = attAll(fields, F.imgMain)
  if (!imgAtts.length) throw new Error('缺少产品白底参考图')
  const gm = pickGenModel(fields)
  const lang = textOf(fields[F.langMain])
  const name = textOf(fields[F.nameMain])
  const count = Number(textOf(fields[F.countMain])) || 3
  // 产品合集图数量：>0 时前 N 张为多款合集图（各款并列同框），其余为单款产品图；上限=总数
  let seriesCnt = Number(textOf(fields[F.seriesCount])) || 0
  if (seriesCnt > count) seriesCnt = count
  const plainCnt = count - seriesCnt
  const report = textOf(fields[F.reportText]) || lookupText(fields[LOOKUP_REPORT]) || '（无，按产品图自行分析）'
  log(`[${S.label}主图] ${recordId} | ${name || '(未填名称)'} | 总数 ${count}（合集 ${seriesCnt} + 单款 ${plainCnt}）| 语言:${lang || '(空)'} | 产品图:${imgAtts.length} 张`)

  // 下载全部产品图；第一张用于提示词规划识图，生图时全部附带
  const prodImgs = []
  for (const att of imgAtts) {
    const buf = await downloadMedia(att.file_token)
    const ext = String(att.name || '').split('.').pop().toLowerCase()
    prodImgs.push({ b64: buf.toString('base64'), mime: att.type || (ext === 'png' ? 'image/png' : 'image/jpeg') })
    log(`[${S.label}主图] 产品图 ${(buf.length / 1024).toFixed(0)}KB`)
  }
  const dataUri = `data:${prodImgs[0].mime};base64,${prodImgs[0].b64}`

  // 前置合集块规划（前 seriesCnt 张 = 多款合集图；仅套件配置了 series_prompt 时生效，如 IP 套件）
  let seriesBlocks = []
  if (seriesCnt > 0 && S.P.series_prompt) {
    seriesBlocks = await planSeriesBlocks(S, { lang, name, styles: '', layout: '', count: seriesCnt, prodImgs })
    log(`[${S.label}主图] 合集规划 ${seriesBlocks.length} 块（目标 ${seriesCnt}）`)
  }

  // 单款块规划：剩余 plainCnt 张按原主图逻辑（模板占位符逐一替换；多张产品图全量给规划识图 + 跨视角约束）
  let plainBlocks = []
  if (plainCnt > 0) {
    const prompt = fill(S.P.main_prompt, {
      '{{3.data.items[].fields.`【人工】语言选择`}}': lang,
      '{{3.data.items[].fields.`需要图片数`}}': String(plainCnt),
      '{{109.report_content}}': report,
    })
    const raw = await chat(MODEL_PROMPT_GEN, 0.7, [
      ...prodImgs.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.b64}` } })),
      { type: 'text', text: prompt + crossNoteOf(S, prodImgs.length, '') },
    ])
    plainBlocks = splitBlocks(raw)
    log(`[${S.label}主图] 单款提示词 ${plainBlocks.length} 块（目标 ${plainCnt}）`)
  }

  // 合并生图：合集块在前、单款块在后（生图逻辑一致：块提示词 + 全部产品图）
  const blocks = [...seriesBlocks, ...plainBlocks]

  // 循环生图：每块建子记录 → 生图 → 上传 → 回填子记录
  const tokens = []
  for (let i = 0; i < blocks.length; i++) {
    if (await stopIfCancelled(S.T.mainImg, recordId, F.statusMain)) return
    try {
      const childId = await addRecord(S.T.mainImg, { [F.promptMainChild]: blocks[i] })
      const r = await geminiImage(gm ? gm.name : MODEL_IMG_PRO, {
        contents: [{ parts: [
          { text: blocks[i] },
          ...prodImgs.map((p) => ({ inline_data: { mime_type: p.mime, data: p.b64 } })),
        ] }],
        generationConfig: { imageConfig: { aspectRatio: pickAspect(fields, '1:1') } },
      }, gm && gm.base)
      const ext = MIME_EXT[r.mime] || 'png'
      const ft = await uploadBitableImage(`main-${i + 1}.${ext}`, r.buf, r.mime)
      await updateRecord(S.T.mainImg, childId, { [F.outMain]: [{ file_token: ft }] })
      tokens.push(ft)
      log(`[${S.label}主图] 第 ${i + 1}/${blocks.length} 张完成 (${(r.buf.length / 1024).toFixed(0)}KB)`)
    } catch (e) {
      log(`[${S.label}主图] 第 ${i + 1} 张失败（跳过继续）:`, e.message.slice(0, 150))
    }
  }
  if (!tokens.length) throw new Error('所有主图均生成失败')

  // 聚合写回主记录（平台轮询字段）+ 状态
  await updateRecord(S.T.mainImg, recordId, {
    [F.outMain]: tokens.map((ft) => ({ file_token: ft })),
    [F.statusMain]: '✅️全部工作流已完成！',
  })
  log(`✅ [主图] 完成 ${tokens.length}/${blocks.length} 张 | 耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}

// ---------- 场景 2：主图修图（tblPQa2zYuN3yYAw，复刻 Make 4673061 nano-banana 双图） ----------
async function xiutuHandler(item, S) {
  const recordId = item.record_id
  const t0 = Date.now()
  const fields = await getRecord(S.T.mainImg, recordId)
  if (await stopIfCancelled(S.T.mainImg, recordId, F.statusMain)) return

  const gm = pickGenModel(fields)
  const editReq = textOf(fields[F.editReq])
  const target = attFirst(fields, F.outMain)
  if (!editReq || !target) throw new Error('缺少修改要求或目标主图')
  const replace = attFirst(fields, F.replaceImg)
  log(`[${S.label}修图] ${recordId} | 要求: ${editReq.slice(0, 60)} | 替换图: ${replace ? '有' : '无'}`)

  const tBuf = await downloadMedia(target.file_token)
  const tB64 = tBuf.toString('base64')
  const parts = [
    { inline_data: { mime_type: 'image/png', data: tB64 } },
    { text: editReq },
  ]
  if (replace) {
    const rBuf = await downloadMedia(replace.file_token)
    parts.push({ inline_data: { mime_type: 'image/png', data: rBuf.toString('base64') } })
  }

  const r = await geminiImage(gm ? gm.name : MODEL_IMG_PRO, {
    contents: [{ role: 'user', parts }],
    generationConfig: { imageConfig: { aspectRatio: '1:1' } },
  })
  const ext = MIME_EXT[r.mime] || 'png'
  const ft = await uploadBitableImage(`xiutu-${Date.now()}.${ext}`, r.buf, r.mime)
  await updateRecord(S.T.mainImg, recordId, { [F.outXiutu]: [{ file_token: ft }] })
  log(`✅ [修图] 完成 | 耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}

// ---------- 场景 2.5：IP 系列合集图（同系列多款同框；参考图=不同款式，非同款多视角） ----------
// 合集场景宽容分块：规划模型输出单块时可能不写 @@@，此时整段当 1 块（主流程的 splitBlocks 会直接抛错）
function seriesLooseBlocks(raw) {
  try { return splitBlocks(raw) } catch {
    const s = String(raw || '').trim()
    return s.length > 50 ? [s] : []
  }
}
// 合集规划公共逻辑：多款参考图 → 目标 count 块合集生图提示词
// （宽容解析：单块无 @@@ 时整段当 1 块；补规划兜底：规划模型常把多方案合并成 1 块，不足则逐块追加）
// 被 seriesHandler（STEP6）/ mainImgHandler（STEP4 前置合集）/ detailHandler（STEP5 前置合集）共用
async function planSeriesBlocks(S, { lang, name, styles, layout, count, prodImgs }) {
  const prompt = fill(S.P.series_prompt, {
    '{{SERIES_NAME}}': name || '（未填）',
    '{{STYLES}}': styles || '（未填，按参考图自行识别区分各款）',
    '{{LAYOUT}}': layout || '（无，由你决定最合适的电商合集构图）',
    '{{COUNT}}': String(count),
    '{{LANG}}': lang || '中文',
  })
  // 多款并列约束（与 crossNoteOf 的同款多视角约束不同：这里是不同款式，防止串款）
  const seriesNote = `\n\n重要约束：随提示词附带的 ${prodImgs.length} 张图片是同一系列的【不同款式】产品实拍图，是并列关系，不是同一产品的不同视角。必须逐张识别每一款的外观特征并各自完整还原：颜色、五官、配件、比例与参考图逐点一致；款式之间禁止互相污染——不得把 A 款的颜色/五官/配件安到 B 款上，也不得发明参考图里不存在的款式；每款在画面中至少有一处完整清晰、不被严重遮挡的形象，主体位置均衡。`
  const raw = await chat(MODEL_PROMPT_GEN, 0.7, [
    ...prodImgs.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.b64}` } })),
    { type: 'text', text: prompt + seriesNote },
  ])
  let blocks = seriesLooseBlocks(raw)
  let tries = 0
  while (blocks.length < count && tries < count) {
    tries++
    const brief = blocks.map((b) => b.replace(/\s+/g, ' ').slice(0, 50)).join('；')
    const extraAsk = `\n\n补充任务：已有的方案概要（不要重复）：${brief}。请再给 1 个【完全不同】的系列合集方案：必须更换场景/机位/排列方式。只输出 1 块完整独立的生图提示词（中文），以「合集图·方案${blocks.length + 1}·」开头，不要输出任何其他内容。`
    const raw2 = await chat(MODEL_PROMPT_GEN, 0.7, [
      ...prodImgs.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.b64}` } })),
      { type: 'text', text: prompt + seriesNote + extraAsk },
    ])
    const more = seriesLooseBlocks(raw2)
    if (!more.length) { log(`[${S.label}合集] 补规划第 ${tries} 次无产出，停止补充`); break }
    blocks = blocks.concat(more)
    log(`[${S.label}合集] 补规划 +${more.length} 块（现 ${blocks.length}/${count}）`)
  }
  if (blocks.length > count) blocks = blocks.slice(0, count)
  return blocks
}

async function seriesHandler(item, S) {
  const recordId = item.record_id
  const t0 = Date.now()
  const fields = await getRecord(S.T.series, recordId)
  if (await stopIfCancelled(S.T.series, recordId, F.statusSeries)) return

  const imgAtts = attAll(fields, F.imgSeries)
  if (imgAtts.length < 2) throw new Error('请至少上传 2 款产品图（每款至少一张），单款请走主图生成')
  const gm = pickGenModel(fields)
  const lang = textOf(fields[F.langMain])
  const name = textOf(fields[F.nameSeries])
  const styles = textOf(fields[F.stylesSeries])
  const layout = textOf(fields[F.layoutSeries])
  const count = Number(textOf(fields[F.countMain])) || 2
  log(`[${S.label}合集] ${recordId} | ${name || '(未填系列名)'} | 参考 ${imgAtts.length} 张 | 目标 ${count} 张`)

  // 下载全部参考图（每款至少一张），规划识图与生图都全量附带
  const prodImgs = []
  for (const att of imgAtts) {
    const buf = await downloadMedia(att.file_token)
    const ext = String(att.name || '').split('.').pop().toLowerCase()
    prodImgs.push({ b64: buf.toString('base64'), mime: att.type || (ext === 'png' ? 'image/png' : 'image/jpeg') })
    log(`[${S.label}合集] 参考图 ${(buf.length / 1024).toFixed(0)}KB`)
  }

  const blocks = await planSeriesBlocks(S, { lang, name, styles, layout, count, prodImgs })
  log(`[${S.label}合集] 提示词 ${blocks.length} 块（目标 ${count}）`)

  const tokens = []
  for (let i = 0; i < blocks.length; i++) {
    if (await stopIfCancelled(S.T.series, recordId, F.statusSeries)) return
    try {
      const childId = await addRecord(S.T.series, { [F.promptSeriesChild]: blocks[i] })
      const r = await geminiImage(gm ? gm.name : MODEL_IMG_PRO, {
        contents: [{ parts: [
          { text: blocks[i] },
          ...prodImgs.map((p) => ({ inline_data: { mime_type: p.mime, data: p.b64 } })),
        ] }],
        generationConfig: { imageConfig: { aspectRatio: pickAspect(fields, '1:1') } },
      }, gm && gm.base)
      const ext = MIME_EXT[r.mime] || 'png'
      const ft = await uploadBitableImage(`series-${i + 1}.${ext}`, r.buf, r.mime)
      await updateRecord(S.T.series, childId, { [F.outSeries]: [{ file_token: ft }] })
      tokens.push(ft)
      log(`[${S.label}合集] 第 ${i + 1}/${blocks.length} 张完成 (${(r.buf.length / 1024).toFixed(0)}KB)`)
    } catch (e) {
      log(`[${S.label}合集] 第 ${i + 1} 张失败（跳过继续）:`, e.message.slice(0, 150))
    }
  }
  if (!tokens.length) throw new Error('所有合集图均生成失败')

  await updateRecord(S.T.series, recordId, {
    [F.outSeries]: tokens.map((ft) => ({ file_token: ft })),
    [F.statusSeries]: '✅️全部工作流已完成！',
  })
  log(`✅ [${S.label}合集] 完成 ${tokens.length}/${blocks.length} 张 | 耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}

// ---------- 场景 3：详情图生成（tblEg52tCy0qEC30，复刻 Make 5628728） ----------
async function detailHandler(item, S) {
  const recordId = item.record_id
  const t0 = Date.now()
  const fields = await getRecord(S.T.detail, recordId)
  if (await stopIfCancelled(S.T.detail, recordId, F.statusDetail)) return

  const gm = pickGenModel(fields)
  const lang = textOf(fields[F.langDetail])
  const name = textOf(fields[F.nameDetail])
  const color = textOf(fields[F.colorDetail])
  const points = textOf(fields[F.pointsDetail])
  const params = textOf(fields[F.paramsDetail])
  const count = Number(textOf(fields[F.countDetail])) || 3
  // 产品合集图数量：>0 时前 N 屏为多款合集图，其余屏为单款产品图；上限=总数
  let seriesCnt = Number(textOf(fields[F.seriesCount])) || 0
  if (seriesCnt > count) seriesCnt = count
  const plainCnt = count - seriesCnt
  const report = textOf(fields[F.reportText]) || lookupText(fields[LOOKUP_REPORT]) || '（无，按产品图自行分析）'
  log(`[${S.label}详情] ${recordId} | ${name || '(未填名称)'} | 总数 ${count}（合集 ${seriesCnt} + 单款 ${plainCnt}）| 语言:${lang || '(空)'}`)

  // 主参考图（新版：从历史批次引用的产品图，可多张；平台层已转附件）——优先使用
  const refAtts = attAll(fields, F.refDetail)
  const refImgs = []
  for (const att of refAtts) {
    try {
      const buf = await downloadMedia(att.file_token)
      const ext = String(att.name || '').split('.').pop().toLowerCase()
      refImgs.push({ b64: buf.toString('base64'), mime: att.type || (ext === 'png' ? 'image/png' : 'image/jpeg') })
      log(`[${S.label}详情] 主参考图 ${(buf.length / 1024).toFixed(0)}KB`)
    } catch (e) { log(`[${S.label}详情] 主参考图下载失败（跳过）:`, e.message.slice(0, 100)) }
  }

  // 下载角度补充参考图（8 角度任一，均选填）
  const imgs = {}   // angle -> {b64, mime}
  for (const [angle, field] of DETAIL_ANGLES) {
    const att = attFirst(fields, field)
    if (!att) continue
    const buf = await downloadMedia(att.file_token)
    const ext = String(att.name || '').split('.').pop().toLowerCase()
    imgs[angle] = { b64: buf.toString('base64'), mime: att.type || (ext === 'png' ? 'image/png' : 'image/jpeg') }
    log(`[${S.label}详情] 补充参考[${DETAIL_ANGLE_CN[angle]}] ${(buf.length / 1024).toFixed(0)}KB`)
  }
  if (!refImgs.length && !Object.keys(imgs).length) throw new Error('请引用主参考图或上传补充参考图（至少其一）')

  // 首选参考图：主参考图优先，其次角度图按兜底链
  const primary = refImgs.length
    ? { b64: refImgs[0].b64, mime: refImgs[0].mime }
    : imgs[DETAIL_FALLBACK.find((a) => imgs[a])]
  // 批次引用展开：全部主参考图 + 全部上传的补充角度图都进提示词规划，让规划模型看全所有视角
  const planAll = [...refImgs, ...Object.values(imgs)]
  const planImgs = planAll.length ? planAll : [primary]

  // 前置合集块规划（前 seriesCnt 屏 = 多款合集图；全部参考图=各款并列；仅套件配置了 series_prompt 时生效）
  let seriesBlocks = []
  if (seriesCnt > 0 && S.P.series_prompt) {
    seriesBlocks = await planSeriesBlocks(S, { lang, name, styles: '', layout: '', count: seriesCnt, prodImgs: planImgs })
    log(`[${S.label}详情] 合集规划 ${seriesBlocks.length} 块（目标 ${seriesCnt}）`)
  }

  // 单款块规划：剩余 plainCnt 屏按原详情逻辑（HTTP58: 提示词生成）
  let plainBlocks = []
  if (plainCnt > 0) {
    const upDown = (a) => (imgs[a] ? '已上传' : '未上传')
    const prompt = fill(S.P.detail_prompt, {
      '{{3.data.items[].fields.`【人工】语言选择`}}': lang,
      '{{3.data.items[].fields.`【输入】产品名称`[].text}}': name,
      '{{3.data.items[].fields.`【输入】产品颜色`[].text}}': color,
      '{{3.data.items[].fields.`【输入】产品亮点`[].text}}': points,
      '{{3.data.items[].fields.`【输入】产品参数`[].text}}': params,
      '{{3.data.items[].fields.`需要数量`}}': String(plainCnt),
      '{{51.report_content}}': report,
      '{{if(3.data.items[1].fields.`【上传】正面图`[1].file_token; "已上传"; "未上传")}}': upDown('front'),
      '{{if(3.data.items[1].fields.`【上传】背面图`[1].file_token; "已上传"; "未上传")}}': upDown('back'),
      '{{if(3.data.items[1].fields.`【上传】左侧图`[1].file_token; "已上传"; "未上传")}}': upDown('left'),
      '{{if(3.data.items[1].fields.`【上传】右侧图`[1].file_token; "已上传"; "未上传")}}': upDown('right'),
      '{{if(3.data.items[1].fields.`【上传】顶部图`[1].file_token; "已上传"; "未上传")}}': upDown('top'),
      '{{if(3.data.items[1].fields.`【上传】底部图`[1].file_token; "已上传"; "未上传")}}': upDown('bottom'),
    })
    const raw = await chat(MODEL_PROMPT_GEN, 0.7, [
      ...planImgs.map((r0) => ({ type: 'image_url', image_url: { url: `data:${r0.mime};base64,${r0.b64}` } })),
      { type: 'text', text: prompt + crossNoteOf(S, planImgs.length, '') },
    ])
    plainBlocks = splitBlocks(raw, plainCnt)
    log(`[${S.label}详情] 单款提示词 ${plainBlocks.length} 块（目标 ${plainCnt}）`)
  }

  // 合并：合集屏在前、单款屏在后
  const blocks = [...seriesBlocks, ...plainBlocks]
  log(`[${S.label}详情] 提示词 ${blocks.length} 块（目标 ${count}）`)

  // 循环生图：合集屏直接全参考图生图；单款屏解析 ANGLE= → 选参考图（带兜底链）→ gemini-3.1-flash-image
  const tokens = []
  for (let i = 0; i < blocks.length; i++) {
    if (await stopIfCancelled(S.T.detail, recordId, F.statusDetail)) return
    try {
      // 合集屏（前 seriesBlocks 块）：全部参考图（各款并列）直接生图，不解析角度、不加单款同视角约束
      const isSeries = i < seriesBlocks.length
      let bodyPrompt
      let ordered
      let refNote
      let angleLabel = '合集'
      if (isSeries) {
        bodyPrompt = blocks[i]
        ordered = planImgs.slice()
        refNote = ''
      } else {
        // code71: 解析 ANGLE= 标记
        const mm = blocks[i].match(/^ANGLE=([a-z_]+)[ \t]*\r?\n([\s\S]*)$/i)
        const angle = mm ? mm[1].toLowerCase() : 'none'
        bodyPrompt = mm ? mm[2].trim() : blocks[i]
        // SetVariable72: 按角度选参考图，未上传则按兜底链；批次引用展开——全部主参考图每张生图都附带
        let ref = imgs[angle]
        if (!ref) for (const a of DETAIL_FALLBACK) { if (imgs[a]) { ref = imgs[a]; break } }
        if (!ref && !refImgs.length) throw new Error('无可用参考图')
        // 目标角度图排第一主参考，其余上传的补充角度图 + 全部批次引用图按序全量附带 + 跨视角约束
        ordered = []
        if (ref) ordered.push(ref)
        for (const im of Object.values(imgs)) if (im !== ref) ordered.push(im)
        for (const r0 of refImgs) if (!ordered.includes(r0)) ordered.push(r0)
        refNote = DETAIL_REF_INSTRUCTION + crossNoteOf(S, ordered.length, DETAIL_ANGLE_CN[angle] || '')
        angleLabel = DETAIL_ANGLE_CN[angle] || angle
      }

      const childId = await addRecord(S.T.detail, { [F.promptDetailChild]: bodyPrompt })
      const parts = [{ text: bodyPrompt + refNote }]
      for (const o of ordered) parts.push({ inline_data: { mime_type: o.mime, data: o.b64 } })
      const r = await geminiImage(gm ? gm.name : MODEL_IMG_DETAIL, {
        contents: [{ parts }],
        generationConfig: { imageConfig: { aspectRatio: pickAspect(fields, '1:1') } },
      }, gm && gm.base)
      const ext = MIME_EXT[r.mime] || 'png'
      const ft = await uploadBitableImage(`detail-${i + 1}.${ext}`, r.buf, r.mime)
      await updateRecord(S.T.detail, childId, { [F.outDetail]: [{ file_token: ft }] })
      tokens.push(ft)
      log(`[${S.label}详情] 第 ${i + 1}/${blocks.length} 张完成 (类型:${angleLabel})`)
    } catch (e) {
      log(`[${S.label}详情] 第 ${i + 1} 张失败（跳过继续）:`, e.message.slice(0, 150))
    }
  }
  if (!tokens.length) throw new Error('所有详情图均生成失败')

  await updateRecord(S.T.detail, recordId, {
    [F.outDetail]: tokens.map((ft) => ({ file_token: ft })),
    [F.statusDetail]: '✅️全部工作流已完成！',
  })
  log(`✅ [详情] 完成 ${tokens.length}/${blocks.length} 张 | 耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}

// ---------- 场景 4：多角度细节图（tbl2Tz2nNa35ILhC，8 角度入口版） ----------
// 新版逻辑：用户按 8 个角度入口上传产品图（至少 1 张）；
// 【输入】指定角度（多选，逗号分隔，空或含「随机」=全部已上传角度）；
// 【输入】每组张数 = 每个角度生成几张（默认 1）；
// LLM 只为选中角度规划提示词分块，每块用对应角度的上传图生成
async function anglesHandler(item, S) {
  const recordId = item.record_id
  const t0 = Date.now()
  const fields = await getRecord(S.T.angles, recordId)
  if (await stopIfCancelled(S.T.angles, recordId, F.statusAngles)) return

  const gm = pickGenModel(fields)
  // 收集已上传的角度图（兼容旧版单列【上传】产品基础图片 → 视作「正面」）
  const uploaded = []   // [{cn, b64, mime}]
  for (const [cn, field] of ANGLE_FIELDS) {
    const att = attFirst(fields, field)
    if (!att) continue
    const buf = await downloadMedia(att.file_token)
    const b64 = buf.toString('base64')
    const mime = b64.startsWith('iVBOR') ? 'image/png' : 'image/jpeg'
    uploaded.push({ cn, b64, mime })
    log(`[${S.label}多角度] 角度图[${cn}] ${(buf.length / 1024).toFixed(0)}KB`)
  }
  if (!uploaded.length) {
    const legacy = attFirst(fields, F.imgAngles)
    if (!legacy) throw new Error('请至少上传一个角度的产品图')
    const buf = await downloadMedia(legacy.file_token)
    const b64 = buf.toString('base64')
    uploaded.push({ cn: '正面', b64, mime: b64.startsWith('iVBOR') ? 'image/png' : 'image/jpeg' })
    log(`[${S.label}多角度] 旧版基础图 → 视作[正面] ${(buf.length / 1024).toFixed(0)}KB`)
  }

  // 指定角度过滤：空或含「随机」= 全部已上传角度；否则只取选中的（且必须有图）
  const multiRaw = textOf(fields[F.multiAngles])
  const picked = multiRaw.includes('随机') || multiRaw.trim() === ''
    ? uploaded
    : multiRaw.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean)
      .map((cn) => uploaded.find((u) => u.cn === cn))
      .filter(Boolean)
  if (!picked.length) throw new Error(`指定角度里没有已上传的图（指定：${multiRaw}；已上传：${uploaded.map((u) => u.cn).join('、')}）`)

  const count = Math.max(1, Number(textOf(fields[F.countAngles])) || 1)
  const report = textOf(fields[F.reportText]) || lookupText(fields[LOOKUP_REPORT]) || '（无，按产品图自行分析）'
  log(`[${S.label}多角度] ${recordId} | 角度: ${picked.map((u) => u.cn).join('、')} | 每组 ${count} 张`)

  // Make route1 模块34: 主记录状态=🎨生成中（认领时已写触发标记，这里补状态）
  await updateRecord(S.T.angles, recordId, { [F.statusAngles]: '🎨生成中' })

  // HTTP132: 8 屏规划提示词 + 本次范围限定
  const prompt = fill(S.P.angles_prompt, { '{{109.report_content}}': report })
    + `\n\n注意：本次只需要输出以下角度的分块：${picked.map((u) => u.cn).join('、')}。每个角度输出 ${count} 个分块（第一行「角度：xxx」格式保持不变；同一角度输出多块时，请在构图、光线、景别上做变化，但角度本身不变）。`
  // 规划识图：附带全部已上传角度图（带角度标注），规划模型才能理解产品完整外观
  const planParts = [
    { type: 'text', text: prompt + `\n\n随提示词附带的 ${uploaded.length} 张图片依次是同一产品的${uploaded.map((u) => '【' + u.cn + '】').join('')}视角实拍图，请基于全部参考图理解产品结构，再为各角度规划提示词。` },
    ...uploaded.map((u) => ({ type: 'image_url', image_url: { url: `data:${u.mime};base64,${u.b64}` } })),
  ]
  const raw = await chat(MODEL_PROMPT_GEN, 0.7, planParts)
  const blocks = splitBlocks(raw)
  const target = picked.length * count
  log(`[${S.label}多角度] 提示词 ${blocks.length} 块（目标 ${target}）`)

  // 循环：每块按「角度：xxx」匹配上传图 → 建子记录 → 生图（1:1）→ 上传 → 回填
  const tokens = []
  for (let i = 0; i < blocks.length; i++) {
    if (await stopIfCancelled(S.T.angles, recordId, F.statusAngles)) return
    try {
      const lines = blocks[i].trim().split('\n')
      const angleName = String(lines[0] || '').replace(/角度：/g, '').trim()
      const bodyText = lines.slice(1).join('\n').trim() || blocks[i].trim()
      // 匹配该角度的上传图：精确匹配，其次包含匹配（如「正面特写」含「正面」），兜底第一张
      const img = uploaded.find((u) => u.cn === angleName)
        || picked.find((u) => angleName.includes(u.cn))
        || uploaded[0]
      // 全量附带已上传角度图：目标角度图排第一（主参考），其余跟后——被遮挡区域由其他视角图定死
      const ordered = [img, ...uploaded.filter((u) => u !== img)]
      const crossNote = `\n\n重要约束：随提示词附带的 ${ordered.length} 张图片依次是同一产品的${ordered.map((u) => '【' + u.cn + '】').join('')}视角实拍图，本次目标画面为「${angleName}」视角。这些参考图共同定义该产品的唯一外观：目标视角下不可见或被遮挡的区域${CROSS_PART[S.key]}，必须与显示该区域最清晰的参考图逐点一致——形状、数量、位置、比例、颜色完全复刻，禁止依据常识或同类产品重新设计；只能改变观察角度、光影与构图，不能重新设计产品的任何特征。若参考图之间出现同一区域的差异，以显示该区域最清晰、最完整的一张为准。`
      const childId = await addRecord(S.T.angles, {
        [F.angleAngles]: angleName,
        [F.statusAngles]: '🎨生成中',
        [F.claim]: recordId,
      })
      const r = await geminiImage(gm ? gm.name : MODEL_IMG_PRO, {
        contents: [{ parts: [
          { text: bodyText + S.angleSuffix + crossNote },
          ...ordered.map((u) => ({ inline_data: { mime_type: u.mime, data: u.b64 } })),
        ] }],
        generationConfig: { imageConfig: { aspectRatio: '1:1' } },
      }, gm && gm.base)
      const ext = MIME_EXT[r.mime] || 'png'
      const ft = await uploadBitableImage(`detail-${childId}.${ext}`, r.buf, r.mime)
      await updateRecord(S.T.angles, childId, { [F.outAngles]: [{ file_token: ft }], [F.statusAngles]: '✅️已生成' })
      tokens.push(ft)
      log(`[${S.label}多角度] 第 ${i + 1}/${blocks.length} 屏完成 (${angleName || '未命名'})`)
    } catch (e) {
      log(`[${S.label}多角度] 第 ${i + 1} 屏失败（跳过继续）:`, e.message.slice(0, 150))
    }
  }
  if (!tokens.length) throw new Error('所有角度图均生成失败')

  // 聚合写回主记录（平台轮询 AI生图 字段；Make 缺此步）
  await updateRecord(S.T.angles, recordId, {
    [F.outAngles]: tokens.map((ft) => ({ file_token: ft })),
    [F.statusAngles]: '✅️已生成',
  })
  log(`✅ [多角度] 完成 ${tokens.length}/${blocks.length} 屏 | 耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}

// ---------- 场景 5：模特+产品图（tblm8T1izOTSyoyh，复刻 Make 7501276 双路由） ----------
// 模特场景：Make 原 code（_bp_prompts*.json 里的 codeEditorJavascript 原文），1:1 保真
// 两套套件各一份（core=手机壳 / ip=IP产品），运行时按 S.key 取
const BUILD_MODEL = {
  core: {
    withPose: new Function('input', PROMPTS.model_code12),
    noPose: new Function('input', PROMPTS.model_code42),
  },
  ip: {
    withPose: new Function('input', PROMPTS_IP.model_code12),
    noPose: new Function('input', PROMPTS_IP.model_code42),
  },
}

async function modelHandler(item, S) {
  const recordId = item.record_id
  const t0 = Date.now()
  const fields = await getRecord(S.T.model, recordId)
  if (await stopIfCancelled(S.T.model, recordId, F.statusModel)) return

  const gm = pickGenModel(fields)
  // 产品白底图支持多张（引用批次/多张上传）：第一张进提示词规划，全部进生图
  const imgAtts = attAll(fields, F.imgModel)
  if (!imgAtts.length) throw new Error('缺少产品白底图')
  const img = imgAtts[0]
  const pose = attFirst(fields, F.poseModel)
  const name = textOf(fields[F.nameModel]) || '该产品'
  const country = textOf(fields[F.countryModel])
  const gender = textOf(fields[F.genderModel])
  const num = Number(textOf(fields[F.countModel])) || 3
  const desc = textOf(fields[F.descModel])
  const report = textOf(fields[F.reportText]) || lookupText(fields[LOOKUP_REPORT])
  log(`[${S.label}模特] ${recordId} | ${name} | ${num} 张 | ${country}/${gender || '-'} | 产品图:${imgAtts.length} 张 | 参考图:${pose ? '有' : '无'}`)

  // Make 模块3: 状态=生成中
  await updateRecord(S.T.model, recordId, { [F.statusModel]: '生成中' })

  const img1B64 = (await downloadMedia(img.file_token)).toString('base64')
  const extraImgs = []
  for (let i = 1; i < imgAtts.length; i++) {
    const buf = await downloadMedia(imgAtts[i].file_token)
    const ext = String(imgAtts[i].name || '').split('.').pop().toLowerCase()
    extraImgs.push({ b64: buf.toString('base64'), mime: imgAtts[i].type || (ext === 'png' ? 'image/png' : 'image/jpeg') })
  }
  let img2B64 = ''
  if (pose) img2B64 = (await downloadMedia(pose.file_token)).toString('base64')

  // code12（有参考图）/ code42（无参考图）构建 chat 请求体
  const body = pose
    ? BUILD_MODEL[S.key].withPose({ img1: img1B64, img2: img2B64, report, name, country, gender, num })
    : BUILD_MODEL[S.key].noPose({ img1: img1B64, report, name, country, gender, num, desc })
  const reqBody = JSON.parse(body)

  // 多张产品图：规划阶段同样全量附带 + 跨视角约束（规划看不到的特征会被脑补——STEP2 镜头区教训）
  if (extraImgs.length) {
    const content = reqBody.messages[0].content
    const textIdx = content.findIndex((p) => p.type === 'text')
    const extraParts = extraImgs.map((e) => ({ type: 'image_url', image_url: { url: `data:${e.mime};base64,${e.b64}` } }))
    if (textIdx >= 0) content.splice(textIdx, 0, ...extraParts)
    else content.push(...extraParts)
    content.push({ type: 'text', text: crossNoteOf(S, 1 + extraImgs.length, '') })
  }

  const raw = await chat(MODEL_PROMPT_GEN, 0.7, reqBody.messages[0].content)
  const blocks = splitBlocks(raw)
  log(`[${S.label}模特] 提示词 ${blocks.length} 块（目标 ${num}）`)

  // code112/142: 生图（3:4，双图 + 多余的产品图全部附带）
  const tokens = []
  for (let i = 0; i < blocks.length; i++) {
    if (await stopIfCancelled(S.T.model, recordId, F.statusModel)) return
    try {
      const parts = [{ text: blocks[i] }, { inline_data: { mime_type: 'image/jpeg', data: img1B64 } }]
      if (img2B64 && img2B64.length > 100) parts.push({ inline_data: { mime_type: 'image/jpeg', data: img2B64 } })
      for (const e of extraImgs) parts.push({ inline_data: { mime_type: e.mime, data: e.b64 } })
      const r = await geminiImage(gm ? gm.name : MODEL_IMG_PRO, {
        contents: [{ parts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: pickAspect(fields, '3:4') } },
      }, gm && gm.base)
      const ext = MIME_EXT[r.mime] || 'png'
      const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
      const ft = await uploadBitableImage(`model-${recordId}-${ts}.${ext}`, r.buf, r.mime)
      tokens.push(ft)
      log(`[${S.label}模特] 第 ${i + 1}/${blocks.length} 张完成`)
    } catch (e) {
      log(`[${S.label}模特] 第 ${i + 1} 张失败（跳过继续）:`, e.message.slice(0, 150))
    }
  }
  if (!tokens.length) throw new Error('所有模特图均生成失败')

  const m = String(raw).match(/@@@([\s\S]*)/)
  await updateRecord(S.T.model, recordId, {
    [F.outModel]: tokens.map((ft) => ({ file_token: ft })),
    [F.promptModel]: m ? m[1] : String(raw),
    [F.statusModel]: '✅️已生成',
  })
  log(`✅ [模特] 完成 ${tokens.length}/${blocks.length} 张 | 耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}

// ---------- 场景 6：AI抠图/生图（tbluHfW8G2N6nrBw，替代原 Make 场景） ----------
// 平台提交 → 本表：正向/负向提示词 + 可选参考图 + 张数(1-4) + 尺寸 + 页面所选生图模型
// 生图直连网关（LLM_BASE + LLM_KEY，服务器 .env；页面选定模型可覆盖），结果写【AI】结果图
async function cutoutHandler(item) {
  const recordId = item.record_id
  const t0 = Date.now()
  const fields = await getRecord(T.cutout, recordId)
  if (await stopIfCancelled(T.cutout, recordId, F.statusCutout)) return

  const gm = pickGenModel(fields)
  const prompt = textOf(fields['【输入】正向提示词']).trim()
  if (!prompt) throw new Error('缺少正向提示词')
  const neg = textOf(fields['【输入】负向提示词']).trim()
  const sizeRaw = textOf(fields['【输入】图片尺寸']).trim()
  // 平台尺寸值映射画幅：1024x1024→1:1 / 1536x1024→16:9 / 1024x1536→3:4；直接传比例值也支持
  const aspect = sizeRaw.includes('1536x1024') ? '16:9'
    : sizeRaw.includes('1024x1536') ? '3:4'
    : ASPECT_SET.has(sizeRaw) ? sizeRaw : '1:1'
  const n = Math.min(Math.max(Number(textOf(fields['【输入】生图张数'])) || 1, 1), 4)
  const refs = attAll(fields, '【上传】参考图')

  log(`[抠图] ${recordId} | ${n} 张 | ${aspect} | 模型:${gm ? gm.name : MODEL_IMG_DETAIL} | 参考图:${refs.length} 张`)
  await updateRecord(T.cutout, recordId, { [F.statusCutout]: '生成中' })

  // 参考图全部下载转 b64（有图=图生图/抠图，无图=文生图）
  const refParts = []
  for (const r of refs) {
    try {
      const buf = await downloadMedia(r.file_token)
      refParts.push({ inline_data: { mime_type: r.type || 'image/png', data: buf.toString('base64') } })
    } catch (e) { log(`[抠图] 参考图下载失败（跳过该张）:`, e.message.slice(0, 100)) }
  }

  const fullPrompt = neg ? `${prompt}\n\n画面中避免出现：${neg}` : prompt
  const tokens = []
  for (let i = 0; i < n; i++) {
    if (await stopIfCancelled(T.cutout, recordId, F.statusCutout)) return
    try {
      const r = await geminiImage(gm ? gm.name : MODEL_IMG_DETAIL, {
        contents: [{ parts: [{ text: fullPrompt }, ...refParts] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: aspect } },
      }, gm && gm.base)
      const ext = MIME_EXT[r.mime] || 'png'
      const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
      const ft = await uploadBitableImage(`cutout-${recordId}-${i + 1}-${ts}.${ext}`, r.buf, r.mime)
      tokens.push(ft)
      log(`[抠图] 第 ${i + 1}/${n} 张完成`)
    } catch (e) {
      log(`[抠图] 第 ${i + 1} 张失败（跳过继续）:`, e.message.slice(0, 150))
    }
  }
  if (!tokens.length) throw new Error('所有图片均生成失败')

  await updateRecord(T.cutout, recordId, {
    [F.outCutout]: tokens.map((ft) => ({ file_token: ft })),
    [F.statusCutout]: '✅️已生成',
  })
  log(`✅ [抠图] 完成 ${tokens.length}/${n} 张 | 耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}

// ---------- 认领与分发 ----------
// 返回该记录归属的场景名；null = 不认领
// 套件感知：同一套判定规则，表 ID 换成所属套件的那张表（core=手机壳 / ip=IP产品）
function classify(tableId, fields) {
  const f = fields || {}
  const claim = textOf(f[F.claim]).trim()
  if (claim !== '') return null   // 已被认领

  const S = suiteOf(tableId)
  const TT = S.T

  if (tableId === TT.report) {
    // 与 report-worker.pickAndProcess 条件一致
    const hasName = textOf(f['【输入】产品名称']).trim() !== ''
    const out = f['【AI生成+人工校对】产品识别报告']
    const noOutput = out == null || out === '' || (Array.isArray(out) && out.length === 0)
    return hasName && noOutput ? 'report' : null
  }
  if (tableId === TT.mainImg) {
    const outX = f[F.outXiutu]
    const noOutX = outX == null || outX === '' || (Array.isArray(outX) && outX.length === 0)
    if (textOf(f[F.editReq]).trim() !== '' && noOutX) return 'xiutu'
    const outM = f[F.outMain]
    const noOutM = outM == null || outM === '' || (Array.isArray(outM) && outM.length === 0)
    if (attFirst(f, F.imgMain) && noOutM) return 'main'
    return null
  }
  if (tableId === TT.series) {
    const out = f[F.outSeries]
    const noOutput = out == null || out === '' || (Array.isArray(out) && out.length === 0)
    const imgs = Array.isArray(f[F.imgSeries]) ? f[F.imgSeries] : []
    return imgs.length >= 2 && noOutput ? 'series' : null   // 至少两款图才认领
  }
  if (tableId === TT.detail) {
    const out = f[F.outDetail]
    const noOutput = out == null || out === '' || (Array.isArray(out) && out.length === 0)
    // 主/子记录区分：新版 UI 不再填产品名称，改用「有图」判定——
    // 主记录有主参考图或任一补充参考图；子记录只有提示词与输出，无任何图
    const hasImg = attFirst(f, F.refDetail) || DETAIL_ANGLES.some(([, fd]) => attFirst(f, fd))
    return hasImg && noOutput ? 'detail' : null
  }
  if (tableId === TT.angles) {
    const out = f[F.outAngles]
    const noOutput = out == null || out === '' || (Array.isArray(out) && out.length === 0)
    // 主/子记录区分：主记录有 8 角度图任一（旧版兼容【上传】产品基础图片）；子记录无图
    const hasImg = ANGLE_FIELDS.some(([, fd]) => attFirst(f, fd)) || attFirst(f, F.imgAngles)
    return hasImg && noOutput ? 'angles' : null
  }
  if (tableId === TT.model) {
    const out = f[F.outModel]
    const noOutput = out == null || out === '' || (Array.isArray(out) && out.length === 0)
    return attFirst(f, F.imgModel) && noOutput ? 'model' : null
  }
  if (tableId === TT.cutout) {
    const out = f[F.outCutout]
    const noOutput = out == null || out === '' || (Array.isArray(out) && out.length === 0)
    return textOf(f['【输入】正向提示词']).trim() !== '' && noOutput ? 'cutout' : null
  }
  return null
}

const HANDLERS = {
  // 报告：两套套件共用 report-worker 的流程，只是表 ID 与提示词不同
  report: (item, S) => REPORT.processRecord(item, {
    tableId: S.T.report,
    reportTpl: S.P.report_prompt,
    ocrPrompt: S.P.ocr_prompt,
    label: `[${S.label}报告]`,
    // 系列款式支持（IP 套件）：模板含 {{STYLE_SECTIONS}} 时才读取款式明细/各款多角度图两个字段
    styleImgField: S.P.report_prompt.includes('{{STYLE_SECTIONS}}') ? '【上传】各款多角度图' : '',
    styleTextField: S.P.report_prompt.includes('{{STYLE_SECTIONS}}') ? '【输入】款式明细' : '',
  }),
  main: mainImgHandler,
  xiutu: xiutuHandler,
  series: seriesHandler,
  detail: detailHandler,
  angles: anglesHandler,
  model: modelHandler,
  cutout: cutoutHandler,
}

async function processClaimed(kind, item, S) {
  const t0 = Date.now()
  try {
    await HANDLERS[kind](item, S)
  } catch (e) {
    // 统一失败状态（含「失败」二字，平台轮询据此判失败，不干等 15 分钟）
    const msg = '🚨生成失败：' + (e && e.message ? String(e.message).slice(0, 150) : String(e))
    log(`❌ [${kind}]`, msg)
    if (kind === 'report') {
      // 报告场景的 processRecord 内部自带失败写状态（【进度状态】），这里不再重复写
    } else {
      try {
        const tid = kind === 'main' || kind === 'xiutu' ? S.T.mainImg
          : kind === 'series' ? S.T.series
          : kind === 'detail' ? S.T.detail : kind === 'angles' ? S.T.angles
          : kind === 'cutout' ? S.T.cutout : S.T.model
        const fid = kind === 'main' || kind === 'xiutu' ? F.statusMain
          : kind === 'series' ? F.statusSeries
          : kind === 'detail' ? F.statusDetail : kind === 'angles' ? F.statusAngles
          : kind === 'cutout' ? F.statusCutout : F.statusModel
        await updateRecord(tid, item.record_id, { [fid]: msg })
      } catch (e2) { log('  写失败状态也失败:', e2.message) }
    }
    throw e
  }
  return Date.now() - t0
}

// 认领：先写触发标记（防 webhook/轮询并发重复处理）
// 注意：报告场景不能预写——REPORT.processRecord 内部自带「先读后认领」，预写会被它当已认领跳过
async function claimAndProcess(tableId, kind, item) {
  const S = suiteOf(tableId)
  const pre = item.fields || (await getRecord(tableId, item.record_id))
  if (textOf(pre[F.claim]).trim() !== '') { log('已被认领，跳过', item.record_id); return false }
  if (kind !== 'report') await updateRecord(tableId, item.record_id, { [F.claim]: item.record_id })
  await processClaimed(kind, { record_id: item.record_id, fields: pre }, S)
  return true
}

// 每张表找 1 条待处理记录
// ---------- 只跑指定套件（本地测试用，避免碰到生产表的在途任务） ----------
// 用法：node hub-worker.cjs --once --only ip    或   --only core
function onlyTables() {
  const i = process.argv.indexOf('--only')
  const k = i >= 0 ? String(process.argv[i + 1] || '').toLowerCase() : ''
  if (k === 'ip') return { list: Object.values(T_IP), label: '仅 IP 套件' }
  if (k === 'core') return { list: TABLE_LIST.filter((t) => SUITE_OF[t] && SUITE_OF[t].key === 'core'), label: '仅手机壳套件' }
  return { list: TABLE_LIST, label: '全部套件' }
}

async function pickAndProcess(tables, tag) {
  let did = 0
  for (const tableId of tables) {
    try {
      const items = await listRecords(tableId)
      for (const it of items) {
        const kind = classify(tableId, it.fields || {})
        if (!kind) continue
        log(`拾取任务 [${tag || ''}${kind}] ${it.record_id} (表 ${tableId})`)
        await claimAndProcess(tableId, kind, it)
        did++
        break   // 每表每轮最多 1 条
      }
    } catch (e) {
      log(`表 ${tableId} 扫描失败（继续下一张）:`, e.message.slice(0, 120))
    }
  }
  return did
}

// ---------- webhook 即时触发（POST /run，body {record_id}，头 x-worker-token） ----------
function startTriggerServer() {
  if (!env.WORKER_PORT) return
  const server = http.createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
    const u = new URL(req.url, 'http://localhost')
    if (req.method !== 'POST' || u.pathname !== '/run') return json(404, { ok: false, error: 'not found' })
    if (!env.WORKER_TOKEN || req.headers['x-worker-token'] !== env.WORKER_TOKEN) return json(403, { ok: false, error: 'forbidden' })
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      let id = ''
      try { id = String(JSON.parse(raw || '{}').record_id || '') } catch { /* ignore */ }
      if (!id) {
        // 兼容 query 形式 /run?id=xxx
        id = u.searchParams.get('id') || ''
      }
      if (!id) return json(400, { ok: false, error: 'missing record_id' })
      json(202, { ok: true, accepted: id })
      // 应答先行；并发查各表定位记录 → 按场景分发（认领防重保证幂等）
      try {
        for (const tableId of TABLE_LIST) {
          let fields = null
          try { fields = await getRecord(tableId, id) } catch { continue }
          const kind = classify(tableId, fields)
          if (kind) {
            log(`webhook 点火 [${kind}] ${id} (表 ${tableId})`)
            await claimAndProcess(tableId, kind, { record_id: id, fields })
            return
          }
        }
        log('webhook 点火未匹配到待处理记录:', id)
      } catch (e) {
        log('webhook 触发处理失败:', e.message)
      }
    })
  })
  server.listen(Number(env.WORKER_PORT), '0.0.0.0', () => log('webhook 触发端口已监听:', env.WORKER_PORT))
  server.on('error', (e) => log('webhook 端口监听失败:', e.message))
}

// ---------- 入口 ----------
async function main() {
  if (!APP_TOKEN || !LLM_BASE || !LLM_KEY || !env.FEISHU_APP_ID) {
    console.error('[fatal] .env 配置不完整（需要 APP_TOKEN/LLM_BASE_URL/LLM_API_KEY/FEISHU_APP_ID/FEISHU_APP_SECRET）')
    process.exit(1)
  }
  const mode = process.argv[2] || ''
  if (mode === '--once') {
    const only = onlyTables()
    const did = await pickAndProcess(only.list, only.label === '仅 IP 套件' ? 'IP·' : '')
    log(did ? `本次处理了 ${did} 条记录（${only.label}），退出` : `没有待处理的记录（${only.label}），退出`)
    process.exit(0)
  } else if (mode === '--loop') {
    const all = onlyTables()
    startTriggerServer()
    log('进入常驻轮询模式，间隔', POLL_INTERVAL_MS, 'ms | 范围:', all.label, '| 监管表:', all.list.join(', '))
    let busy = false
    const tick = async () => {
      if (busy) return
      busy = true
      try { await pickAndProcess(all.list) } catch (e) { log('本轮出错（下轮继续）:', e.message) }
      busy = false
    }
    await tick()
    setInterval(tick, POLL_INTERVAL_MS)
  } else {
    console.log('用法: node hub-worker.cjs --once | --loop [--only ip|core]')
    process.exit(1)
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[fatal]', e.message); process.exit(1) })
}
