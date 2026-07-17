import dotenv from 'dotenv'
import { GoogleGenAI } from '@google/genai'

dotenv.config()

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY, apiVersion: 'v1beta' })
const MODEL_FALLBACKS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-mini', 'gemini-1.5', 'gemini-1.0']

function extractTextFromNode(node) {
  if (node == null) return ''
  if (typeof node === 'string') return node.trim()
  if (typeof node === 'number' || typeof node === 'boolean') return String(node)
  if (Array.isArray(node)) return node.map(extractTextFromNode).filter(Boolean).join(' ')
  if (typeof node === 'object') {
    if (typeof node.text === 'string' && node.text.trim()) return node.text.trim()
    if (typeof node.output_text === 'string' && node.output_text.trim()) return node.output_text.trim()
    if (typeof node.content === 'string' && node.content.trim()) return node.content.trim()
    return Object.values(node).map(extractTextFromNode).filter(Boolean).join(' ')
  }
  return ''
}

function parseResponseText(response) {
  if (!response) return ''
  const candidates = []
  if (typeof response.text === 'string') candidates.push(response.text)
  if (typeof response.output_text === 'string') candidates.push(response.output_text)
  if (typeof response.output === 'string') candidates.push(response.output)
  if (Array.isArray(response.output)) candidates.push(...response.output)
  if (Array.isArray(response.outputs)) candidates.push(...response.outputs)
  if (Array.isArray(response.candidates)) candidates.push(...response.candidates)
  const parsed = candidates
    .map(extractTextFromNode)
    .map((text) => (typeof text === 'string' ? text.trim() : ''))
    .find(Boolean)
  if (parsed) return parsed
  return extractTextFromNode(response)
}

async function generateText(prompt, maxOutputTokens = 120) {
  let lastError = null
  for (const model of MODEL_FALLBACKS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        temperature: 0.2,
        maxOutputTokens,
      })
      console.log(`Gemini model ${model} response keys:`, Object.keys(response))
      console.log(`Gemini model ${model} response sample:`, JSON.stringify(response, null, 2).slice(0, 1200))
      const parsed = parseResponseText(response)
      if (!parsed) {
        console.warn(`Gemini model ${model} returned empty response. Trying next fallback.`, 'Response keys:', Object.keys(response))
        continue
      }
      return parsed
    } catch (error) {
      lastError = error
      const errorMessage = error?.message || JSON.stringify(error)
      console.error(`Gemini model ${model} request failed:`, errorMessage)
      if (errorMessage.includes('NOT_FOUND') || errorMessage.includes('not available') || errorMessage.includes('model')) {
        console.warn(`Model ${model} unavailable, trying next fallback.`)
        continue
      }
      console.warn(`Gemini model ${model} failed with a non-model error, trying next fallback if available.`)
      continue
    }
  }
  console.error('All Gemini model fallbacks failed.', lastError)
  return ''
}

export async function summarizeEntry(text) {
  if (!process.env.GOOGLE_API_KEY) return ''
  const prompt = `あなたはエンジニア向けの知識整理アシスタントです。以下のDiscordメッセージを読み、技術的な問題点や解決方法、学んだ内容を1文でわかりやすく要約してください。余計な語句は省いてください。\n\nメッセージ:\n"""${text}"""`
  return await generateText(prompt, 120)
}

export async function generateTags(text) {
  if (!process.env.GOOGLE_API_KEY) return []
  const prompt = `以下のDiscordメッセージから技術タグを3つ以内で抽出し、カンマ区切りで返してください。タグのみを返し、不要な説明は含めないでください。\n\nメッセージ:\n"""${text}"""`
  const raw = await generateText(prompt, 60)
  if (!raw) return []
  return raw
    .replace(/\[|\]|"|'/g, '')
    .split(/[、,;\n]+/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .slice(0, 5)
}

function createLocalWeeklyReport(rows) {
  const total = rows.length
  const tagSet = new Set()
  rows.forEach((row) => {
    if (Array.isArray(row.tags)) {
      row.tags.forEach((tag) => {
        if (typeof tag === 'string' && tag.trim()) {
          tagSet.add(tag.trim().toLowerCase())
        }
      })
    }
  })
  const tags = [...tagSet].slice(0, 8)
  const latestSummaries = rows.slice(0, 3).map((row, index) => `最新${index + 1}: ${row.summary || row.content || '内容なし'}`)
  return `今週の記録は合計${total}件です。主なタグは${tags.length ? tags.join('、') : '特にありません'}。${latestSummaries.join(' ')} 今後は、問題の再現手順と解決方法を整理し、記録をより丁寧に残すことをおすすめします。`
}

export async function generateWeeklyReport(rows) {
  if (!process.env.GOOGLE_API_KEY) return createLocalWeeklyReport(rows)
  const lines = rows.map((row, index) => {
    const tags = Array.isArray(row.tags) ? row.tags.join(', ') : ''
    return `${index + 1}) ${new Date(row.created_at).toLocaleDateString()} ${tags ? `[${tags}] ` : ''}${row.summary}`
  })
  const prompt = `あなたはエンジニアの学習記録をまとめるアシスタントです。以下の記録を読み取り、今週の学習進捗と改善点、注目すべき技術内容、次に取り組むべきことを、エンジニア向けに丁寧かつ前向きな文章でレポートにまとめてください。\n\n記録:\n${lines.join('\n')}\n\nレポート:`
  const report = await generateText(prompt, 350)
  if (!report) {
    console.warn('Gemini report generation failed or returned empty. Falling back to local weekly report.')
    return createLocalWeeklyReport(rows)
  }
  return report
}
