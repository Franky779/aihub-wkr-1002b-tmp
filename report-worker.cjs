#!/usr/bin/env node
/**
 * report-worker.cjs — 「产品报告生成」worker
 *
 * 替代 Make 场景（报告蓝图），逻辑与提示词 1:1 复刻：
 *   Make 原流程: webhook 点火 → 飞书写触发标记 → 读记录 → 下载图片 → 传 Cloudinary 拿公网 URL
 *              → 模型① OCR 识图文字 → 清洗 → 模型② 生成报告 → 写回报告 + 进度状态=准备开始 → 全表翻转状态
 *   本脚本改动: ①触发改为轮询飞书表（认领 = 写触发标记） ②图片不传 Cloudinary，转 base64 data URI 直塞模型
 *              其余（提示词、模型、温度、字段、写回值）与 Make 完全一致
 *
 * 用法:
 *   node report-worker.cjs --once   # 处理最多 1 条记录后退出（测试用）
 *   node report-worker.cjs --loop   # 常驻轮询（服务器部署用）
 *
 * 依赖: 仅 Node.js >= 18（原生 fetch），零 npm 依赖
 * 配置: 同目录 .env（见 .env.example）
 */

'use strict'
const fs = require('fs')
const path = require('path')
const http = require('http')

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
const TABLE_ID = env.TABLE_ID
const LLM_BASE = (env.LLM_BASE_URL || '').replace(/\/$/, '')
const LLM_KEY = env.LLM_API_KEY
const POLL_INTERVAL_MS = Number(env.POLL_INTERVAL_MS || 15000)
const LLM_TIMEOUT_MS = Number(env.LLM_TIMEOUT_MS || 480000)

// 模型与温度：与 Make 蓝图一致
const MODEL_OCR = 'gemini-3.7-flash'   // 模块8：图片文字识读
const TEMP_OCR = 0
const MODEL_REPORT = 'gpt-5.6-sol'     // 模块6：产品报告生成
const TEMP_REPORT = 0.7

// 表字段名（与飞书多维表格一致）
const F = {
  name: '【输入】产品名称',
  color: '【输入】产品颜色',
  points: '【输入】产品亮点',
  params: '【输入】产品参数',
  lang: '【输入】语言选择', // Make 模板里引用的是「【人工】语言选择」，实际表字段是「【输入】语言选择」，按实际取
  output: '【AI生成+人工校对】产品识别报告',
  progress: '【进度状态】',
  claim: '【系统】触发标记',
  cancelFlag: '【系统】取消标记',
}
// 九个角度：显示名 → 表字段名（顺序与 Make 模块30 一致，不得改动）
const ANGLES = [
  ['正面', '【上传】正面图'],
  ['背面', '【上传】背面图'],
  ['左侧', '【上传】左侧图'],
  ['右侧', '【上传】右侧图'],
  ['顶部', '【上传】顶部图'],
  ['底部', '【上传】底部图'],
  ['展开', '【上传】展开图'],
  ['折叠/变形后', '【上传】折叠/变形后图'],
  ['功能展示', '功能展示图'],
]

// 提示词（由蓝图原样注入，勿手改）
const OCR_PROMPT = "只做一件事：逐字识读这些商品图片上出现的文字，用于电商产品报告的文字核对。\n规则：\n1. 读出产品本体、包装、贴纸、屏幕上清晰可见的文字，包括机身侧面压印、雕刻、暗纹里的品牌字母；逐字母确认，任何一个字母没把握就写「不确定」，不要猜测、不要补全成看起来合理的单词。\n2. 只输出下面这一行，不要换行、不要使用引号、不要解释、不要描述画面。\n输出格式：品牌名：<品牌名或未识别>；其它可见文字：<用/分隔，没有就写无>"
const REPORT_TPL = "任务说明：产品信息智能提取，请仔细分析我上传的产品图片和提供的产品基本信息（产品名称：{{2.data.items[].fields.`【输入】产品名称`[].text}}，产品颜色：{{2.data.items[].fields.`【输入】产品颜色`[].text}}，产品亮点：{{2.data.items[].fields.`【输入】产品亮点`[].text}}，产品参数：{{2.data.items[].fields.`【输入】产品参数`[].text}}，语言选择：{{2.data.items[].fields.`【人工】语言选择`}}），自动提取以下信息： 1,自动识别项目.2,品牌名称识别:2-1,从包装/产品上识别品牌LOGO文字 .2-2,识别中文品牌名和英文品牌名.   2-3,提取品牌标志的设计风格（字体、图标、配色）.3,产品类型判断:3-1,识别产品所属类别（服装/食品/电子/美妆/家居/宠物用品等） . 3-2,识别具体产品名称（从包装文字或产品形态判断） .  3-3,识别产品规格（尺寸、容量、重量等）.4,卖点提取:   4-1,从包装上的文案提取核心卖点关键词   .4-2,从产品图标/认证标识提取卖点（如：有机认证、无添加、进口等）  . 4-3,从产品视觉特征推断卖点（如：颜色、材质、工艺）   .4-4,提取数据卖点（如：百分比、含量、时长等）.4-5,联网搜索产品相关卖点.5,目标受众推断:   5-1,根据包装风格推断目标用户群体   .5-2,根据产品类型推断年龄段   .5-3,根据价格定位推断消费层级.6,产品参数提取 :  6-1,从包装文字提取产品规格（净含量/尺码/功率等）.   6-2,提取成分信息/配料表/营养成分   .6-3,提取使用说明/注意事项   .6-4,提取生产日期/保质期/储存方式。.7,产品细节识别   :7-1,识别产品材质质感（光滑/粗糙/哑光/高光等）.7-2,识别产品结构特点（可拆卸/折叠/便携等）.7-3,识别包装特色（自封袋/泵头/喷雾/滴管等）.8,特殊需求（可选）:8-1,是否需要模特：是 / 否（如果是，描述模特类型）.8-2,是否需要场景：是 / 否（如果是，描述场景类型）.8-3,是否需要数据可视化：是 / 否(其他特殊要求)：如：必须包含产品实物、需要对比图、需要用户评价等.  输出格式： 请将识别结果整理为以下格式： 【识别报告】 品牌名称：[中文品牌名，只允许来自画面中清晰大号印刷文字；机身压印、雕刻、暗纹小字一律不采信，读不到就写「未识别」] / [英文品牌名，同样只允许来自清晰大号印刷文字，读不到就写「Unknown」]  产品类型：[大类] - [具体产品]  产品语言：[需要显示的语言语种] 产品规格：[具体规格]  核心卖点：[卖点1 - 中文] [卖点2 - 中文] [卖点3 - 中文] [卖点4 - 中文] [卖点5 - 中文]  目标受众：[用户画像] 品牌调性：[调性描述] 包装亮点：[特殊设计元素] 特殊需求：[特殊需求描述]\n\n【本次随请求上传的图片】\n{{30.result.legend}}\n\n【各角度图片描写】\n正面：\n背面：\n左侧：\n右侧：\n顶部：\n底部：\n展开：\n折叠/变形后：\n功能展示：\n\n【各角度图片描写要求】\n1. 上述九行角度名称与顺序固定不变，必须原样保留，不得增删、改名或调序。\n2. 只描写本次随请求实际上传了图片的角度，把描写写在该角度名称的冒号后面。\n3. 没有上传图片的角度，冒号后面一律留空，不得写任何内容（包括「未上传」「无」「N/A」「留空」等字样），也不得根据其它角度的图片推测该角度。\n4. 每个角度的描写必须完全来自该角度对应的那一张图片，写清画面里真实可见的内容：拍摄视角与构图、产品在画面中的形态与占比、可见的结构与部件、材质与表面质感、颜色、光泽与光影、画面中可见的文字/Logo/图案，以及有辨识度的局部细节。\n5. 每个角度 60~150 字，具体克制；不堆砌卖点，不与其它角度重复，不写「如图」「图片显示」这类废话，不写看不到的信息。\n6. 描写的语言与报告正文语言保持一致。\n7. 描写里禁止写出机身压印、雕刻、暗纹小字的具体拼写，只能描述它的位置、方向、大小和外观（例如「接缝处有一行竖排压印大写字母」）。\n\n【独立文字识读结果（由另一个模型专门逐字识读，优先级最高）】\n{{31.result.text}}\n\n【文字使用规则（最高优先级）】\n1. 报告里出现的任何具体文字（品牌名、印在产品或包装上的词语），必须与上面的独立文字识读结果一致；识读结果里没有的词，一律不要写进报告，也不要根据机身压印、雕刻、暗纹小字自行拼写。\n2. 「品牌名称」只填写识读结果里的品牌名；识读结果写「未识别」或没给出品牌名时，品牌名称一律写「未识别 / Unknown」。\n3. 各角度图片描写里不要写出机身压印、雕刻、暗纹小字的具体拼写，只描述它的位置、方向、大小和外观。\n4. 以上规则优先于其它所有要求。"

// ---------- 工具 ----------
const log = (...a) => console.log(new Date().toISOString(), '|', ...a)

function textOf(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map((s) => (s && typeof s === 'object' && 'text' in s ? String(s.text) : String(s))).join('')
  return String(v)
}

// 飞书 tenant_access_token（缓存 90 分钟）
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

async function feishu(path, init) {
  const token = await tenantToken()
  const res = await fetch(FEISHU_BASE + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, ...(init && init.headers ? init.headers : {}) },
  })
  return res
}

// 说明：tableId 缺省时用 .env 的 TABLE_ID（手机壳系列）。
// 「IP产品电商图生成」系列复用同一套流程，由 hub-worker.cjs 传入自身表 ID 与 IP 版提示词。
async function listRecords(tableId) {
  const tid = tableId || TABLE_ID
  const items = []
  let pageToken = ''
  do {
    const q = new URLSearchParams({ page_size: '50' })
    if (pageToken) q.set('page_token', pageToken)
    const res = await feishu(`/bitable/v1/apps/${APP_TOKEN}/tables/${tid}/records?` + q.toString())
    const j = await res.json()
    if (j.code !== 0) throw new Error('列出记录失败: ' + j.code + ' ' + j.msg)
    items.push(...(j.data.items || []))
    pageToken = j.data.has_more ? j.data.page_token : ''
  } while (pageToken)
  return items
}

async function getRecord(recordId, tableId) {
  const tid = tableId || TABLE_ID
  const res = await feishu(`/bitable/v1/apps/${APP_TOKEN}/tables/${tid}/records/${recordId}`)
  const j = await res.json()
  if (j.code !== 0) throw new Error('读取记录失败: ' + j.code + ' ' + j.msg)
  return j.data.record.fields
}

async function updateRecord(recordId, fields, tableId) {
  const tid = tableId || TABLE_ID
  const res = await feishu(`/bitable/v1/apps/${APP_TOKEN}/tables/${tid}/records/${recordId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  const j = await res.json()
  if (j.code !== 0) throw new Error('更新记录失败: ' + j.code + ' ' + j.msg)
  return true
}

async function downloadMedia(fileToken) {
  const res = await feishu(`/drive/v1/medias/${fileToken}/download`)
  if (!res.ok) throw new Error('下载飞书附件失败: HTTP ' + res.status + ' token=' + fileToken)
  return Buffer.from(await res.arrayBuffer())
}

// OpenAI 兼容 chat/completions（与 Make HTTP 模块同一接口）
async function chat(model, temperature, content) {
  return chatWithBase(model, temperature, content, '')
}

// chat 的带平台覆盖版本：baseOverride 传裸域名时用其 /v1/chat/completions（页面选定模型平台）
async function chatWithBase(model, temperature, content, baseOverride) {
  const base = baseOverride ? baseOverride.replace(/\/+$/, '') + '/v1' : LLM_BASE
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + LLM_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`模型 ${model} HTTP ${res.status}: ` + t.slice(0, 300))
  }
  const j = await res.json()
  const msg = j.choices && j.choices[0] && j.choices[0].message
  if (!msg) throw new Error(`模型 ${model} 返回无 choices: ` + JSON.stringify(j).slice(0, 300))
  return typeof msg.content === 'string' ? msg.content : String(msg.content ?? '')
}

const EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }

// ---------- 主流程（1:1 复刻 Make） ----------
// opts: { tableId, reportTpl, ocrPrompt, label }
//   tableId    缺省 env.TABLE_ID（手机壳系列报告表）；IP 系列由 hub-worker 传入
//   reportTpl  缺省 REPORT_TPL（手机壳版）；IP 系列传 IP 版提示词
//   ocrPrompt  缺省 OCR_PROMPT（两套通用，保留口子）
//   label      日志前缀，如 '[IP报告]'
async function processRecord(item, opts) {
  const recordId = item.record_id
  const t0 = Date.now()
  const o = opts || {}
  const tid = o.tableId || TABLE_ID
  const TPL = o.reportTpl || REPORT_TPL
  const OCRP = o.ocrPrompt || OCR_PROMPT
  const L = o.label || ''

  // 防重复：webhook 与轮询可能同时命中，先读后认领；已认领的直接跳过
  const pre = await getRecord(recordId, tid).catch(() => null)
  if (pre && textOf(pre[F.claim]).trim() !== '') {
    log('已被认领，跳过', recordId)
    return
  }

  log(L || '[报告]', '认领记录', recordId)

  // 模块1: 写触发标记（= 认领）
  await updateRecord(recordId, { [F.claim]: recordId }, tid)

  // 模块2: 读记录
  const fields = pre || (await getRecord(recordId, tid))
  const name = textOf(fields[F.name])
  const color = textOf(fields[F.color])
  const points = textOf(fields[F.points])
  const params = textOf(fields[F.params])
  const lang = textOf(fields[F.lang])
  log(L || '[报告]', '输入:', name, '| 语言:', lang || '(空)')

  try {
    // 模块 30 前置：按角度顺序收集图片（有附件才带上），下载转 data URI（替代 Cloudinary）
    const images = [] // {name, dataUri}
    for (const [angle, field] of ANGLES) {
      const att = fields[field]
      if (Array.isArray(att) && att[0] && att[0].file_token) {
        const f = att[0]
        const ext = String(f.name || '').split('.').pop().toLowerCase()
        const mime = EXT_MIME[ext] || 'image/jpeg'
        const buf = await downloadMedia(f.file_token)
        images.push({ name: angle, dataUri: `data:${mime};base64,${buf.toString('base64')}` })
        log(`  图片[${angle}] ${(buf.length / 1024).toFixed(0)}KB`)
      }
    }
    // 注意：空图校验推迟到款式图合并之后——只传「各款式多角度图」不传正面图是合法输入

    // 系列款式（可选，仅配置了字段名时生效）：各款多角度图附件 + 款式明细文本
    // 图片按「款式明细」每行的张数依次对应款式名，legend 逐张命名为「款式「xx」第n张」，
    // 报告提示词用 {{STYLE_SECTIONS}} 注入明细并要求输出「每款产品详细描述」章节
    let stylesSection = ''
    if (o.styleImgField && Array.isArray(fields[o.styleImgField]) && fields[o.styleImgField].length) {
      const styleAtts = fields[o.styleImgField]
      const detailRaw = o.styleTextField ? textOf(fields[o.styleTextField]) : ''
      // 解析明细行「1. 款式名：N张（第a-b张）」→ 每张图对应款式名
      const parsed = []
      for (const line of detailRaw.split(/\r?\n/)) {
        const m = line.match(/^\s*\d+\.\s*(.+?)[：:]\s*(\d+)张/)
        if (m) parsed.push({ name: m[1].trim(), n: Number(m[2]) || 0 })
      }
      const styleNames = []
      for (const p of parsed) for (let j = 0; j < p.n; j++) styleNames.push(p.name)
      for (let k = styleNames.length; k < styleAtts.length; k++) styleNames.push('未标注款式')
      for (let i = 0; i < styleAtts.length; i++) {
        const f = styleAtts[i]
        const ext = String(f.name || '').split('.').pop().toLowerCase()
        const mime = EXT_MIME[ext] || 'image/jpeg'
        const buf = await downloadMedia(f.file_token)
        images.push({ name: `款式「${styleNames[i]}」第${i + 1}张`, dataUri: `data:${mime};base64,${buf.toString('base64')}` })
        log(`  图片[款式${i + 1}:${styleNames[i]}] ${(buf.length / 1024).toFixed(0)}KB`)
      }
      stylesSection = detailRaw.trim() || styleAtts.map((_, i) => `${i + 1}. ${styleNames[i]}：1张`).join('\n')
      log(`  款式: ${styleAtts.length} 张款式图 / ${parsed.length} 款（明细解析）`)
    }
    if (!images.length) throw new Error('没有任何图片附件（正面图与各款式多角度图至少传其一），无法生成报告')

    // 模块30: frag（图片块）与 legend（图片清单文字）——款式图已并入 images，legend 一并列出
    const frag = images.map((im) => ({ type: 'image_url', image_url: { url: im.dataUri } }))
    const legend = images.length
      ? '本次随请求上传的图片，按顺序依次为：' + images.map((im) => im.name).join('、') + '。'
      : '本次没有上传任何角度图片。'

    // 模块8: OCR 识图文字
    log('调用模型① OCR:', MODEL_OCR, '(图片', images.length, '张)')
    const ocrRaw = await chat(MODEL_OCR, TEMP_OCR, [{ type: 'text', text: OCRP }, ...frag])
    // 模块31: 清洗
    const ocr = (() => {
      const clean = String(ocrRaw == null ? '' : ocrRaw).replace(/[\r\n\t]+/g, ' ').replace(/["\\]/g, '').trim()
      return clean === '' ? '未识别（文字识读未执行）' : clean
    })()
    log('  OCR 结果:', ocr.slice(0, 120))

    // 取消检查：平台「停止」按钮写【系统】取消标记，检测到则中止（OCR 已跑完，报告生成不再进行）
    const cf = await getRecord(recordId, tid).catch(() => null)
    if (cf && textOf(cf[F.cancelFlag]).trim() !== '') {
      await updateRecord(recordId, { [F.progress]: '⏹已停止（用户取消）' }, tid)
      log('⏹ 用户已取消，中止报告生成', recordId)
      return
    }

    // 模块6: 生成报告（模板占位符用函数替换，避免 $ 符号被解释）
    const prompt = TPL
      .replace('{{2.data.items[].fields.`【输入】产品名称`[].text}}', () => name)
      .replace('{{2.data.items[].fields.`【输入】产品颜色`[].text}}', () => color)
      .replace('{{2.data.items[].fields.`【输入】产品亮点`[].text}}', () => points)
      .replace('{{2.data.items[].fields.`【输入】产品参数`[].text}}', () => params)
      .replace('{{2.data.items[].fields.`【人工】语言选择`}}', () => lang)
      .replace('{{30.result.legend}}', () => legend)
      .replace('{{31.result.text}}', () => ocr)
      .replace('{{STYLE_SECTIONS}}', () => stylesSection || '（未提供：本产品为单款或未填写款式信息）')
    log('调用模型② 报告:', MODEL_REPORT)
    // 页面「生图大模型」选择卡（STEP1 报告页同样可选）：【输入】生图模型 = 实际模型名@@裸URL，覆盖默认报告模型
    let reportModel = MODEL_REPORT
    let reportBase = ''
    const gmRaw = textOf(fields['【输入】生图模型']).trim()
    if (gmRaw.includes('@@')) {
      const [gn, gb] = gmRaw.split('@@')
      if (gn.trim()) { reportModel = gn.trim(); reportBase = (gb || '').replace(/\/+$/, '') }
      log('  使用页面选定模型:', reportModel, reportBase ? '(平台 ' + reportBase + ')' : '')
    }
    const report = await chatWithBase(reportModel, TEMP_REPORT, [{ type: 'text', text: prompt }, ...frag], reportBase)

    // 模块7: 写回报告 + 进度状态（ifempty 兜底同 Make）
    const finalReport = report && report.trim() !== '' ? report : '【警报】产品报告生成错误，请3分钟后重试一次！'
    await updateRecord(recordId, { [F.output]: finalReport, [F.progress]: '准备开始' }, tid)
    log('✅ 报告已写回', recordId, '| 长度', finalReport.length, '| 耗时', ((Date.now() - t0) / 1000).toFixed(0) + 's')

    // 路由2: 全表把「产品报告已生成」翻回「准备开始」（与 Make 路由2 一致）
    const all = await listRecords(tid)
    for (const it of all) {
      const p = textOf(it.fields[F.progress])
      if (p === '产品报告已生成') {
        await updateRecord(it.record_id, { [F.progress]: '准备开始' }, tid)
        log('  状态翻转: 产品报告已生成 → 准备开始 |', it.record_id)
      }
    }
  } catch (e) {
    // 失败：进度状态带「失败」字样，平台轮询会据此把任务标失败（不挂 15 分钟）
    const msg = '生成失败：' + (e && e.message ? String(e.message).slice(0, 200) : String(e))
    log('❌', msg)
    try { await updateRecord(recordId, { [F.progress]: msg }, tid) } catch (e2) { log('  写失败状态也失败:', e2.message) }
    throw e
  }
}

async function pickAndProcess() {
  const items = await listRecords()
  const target = items.find((it) => {
    const f = it.fields || {}
    const hasName = textOf(f[F.name]).trim() !== ''
    const noOutput = f[F.output] == null || f[F.output] === '' || (Array.isArray(f[F.output]) && f[F.output].length === 0)
    const noClaim = f[F.claim] == null || f[F.claim] === ''
    return hasName && noOutput && noClaim
  })
  if (!target) return false
  await processRecord(target)
  return true
}

// webhook 即时触发端点（与轮询互为兜底）：POST /run?id=<record_id>，头 x-worker-token 鉴权
function startTriggerServer() {
  if (!env.WORKER_PORT) return
  const server = http.createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
    const u = new URL(req.url, 'http://localhost')
    if (req.method !== 'POST' || u.pathname !== '/run') return json(404, { ok: false, error: 'not found' })
    if (!env.WORKER_TOKEN || req.headers['x-worker-token'] !== env.WORKER_TOKEN) return json(403, { ok: false, error: 'forbidden' })
    const id = u.searchParams.get('id')
    if (!id) return json(400, { ok: false, error: 'missing id' })
    json(202, { ok: true, accepted: id })
    // 应答先行，处理异步；认领防重保证与轮询并发安全
    processRecord({ record_id: id }).catch((e) => log('webhook 触发处理失败:', e.message))
  })
  server.listen(Number(env.WORKER_PORT), '0.0.0.0', () => log('webhook 触发端口已监听:', env.WORKER_PORT))
  server.on('error', (e) => log('webhook 端口监听失败:', e.message))
}

async function main() {
  if (!APP_TOKEN || !TABLE_ID || !LLM_BASE || !LLM_KEY) {
    console.error('[fatal] .env 配置不完整（需要 APP_TOKEN/TABLE_ID/LLM_BASE_URL/LLM_API_KEY/FEISHU_APP_ID/FEISHU_APP_SECRET）')
    process.exit(1)
  }
  const mode = process.argv[2] || ''
  if (mode === '--once') {
    const did = await pickAndProcess()
    log(did ? '本次处理了 1 条记录，退出' : '没有待处理的记录，退出')
    process.exit(0)
  } else if (mode === '--loop') {
    startTriggerServer()
    log('进入常驻轮询模式，间隔', POLL_INTERVAL_MS, 'ms')
    let busy = false
    const tick = async () => {
      if (busy) return
      busy = true
      try { await pickAndProcess() } catch (e) { log('本轮出错（下轮继续）:', e.message) }
      busy = false
    }
    await tick()
    setInterval(tick, POLL_INTERVAL_MS)
  } else {
    console.log('用法: node report-worker.cjs --once | --loop')
    process.exit(1)
  }
}

// 独立运行入口（被 hub-worker.cjs require 时不执行）
if (require.main === module) {
  main().catch((e) => { console.error('[fatal]', e.message); process.exit(1) })
}

// 供 hub-worker.cjs 复用报告处理逻辑
module.exports = { processRecord, env, textOf }
