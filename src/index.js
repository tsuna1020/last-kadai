import dotenv from 'dotenv'
import http from 'node:http'
import { Client, GatewayIntentBits, REST, Routes } from 'discord.js'
import pool from './db/index.js'
import { summarizeEntry, generateTags, generateWeeklyReport } from './ai/gemini.js'

dotenv.config()

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] })

const commands = [
  { name: 'help', description: 'ボットの使い方を表示します' },
  {
    name: 'search',
    description: 'タグで過去の記録を検索します',
    options: [
      { name: 'tag', description: 'タグ名 (例: Python)', type: 3, required: true }
    ]
  },
  { name: 'report', description: '直近の学習記録からレポートを生成します' }
]

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`)

  if (!process.env.DISCORD_TOKEN) {
    console.warn('DISCORD_TOKEN が設定されていません。スラッシュコマンド登録をスキップします。')
    return
  }

  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN)
    if (process.env.GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID), { body: commands })
      console.log('Registered guild commands')
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands })
      console.log('Registered global commands')
    }
  } catch (err) {
    console.error('Failed to register commands:', err)
  }
})

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return

  const { commandName } = interaction

  if (commandName === 'help') {
    await interaction.reply({ content: 'このボットは学習ログを自動で収集し、`/search` と `/report` で活用できます。' })
  }

  if (commandName === 'search') {
    const tag = interaction.options.getString('tag')
    await interaction.deferReply()
    try {
      const normalizedTag = normalizeTag(tag)
      const q = `
        SELECT created_at, summary, tags
        FROM journals
        WHERE EXISTS (
          SELECT 1 FROM unnest(tags) AS t WHERE lower(t) = $1
        )
        ORDER BY created_at DESC
        LIMIT 5
      `
      const res = await pool.query(q, [normalizedTag])
      if (res.rows.length === 0) {
        await interaction.editReply(`タグ "${tag}" に一致する記録は見つかりませんでした。`)
        return
      }
      const lines = res.rows.map(r => `- ${new Date(r.created_at).toLocaleString()} [${(r.tags || []).join(', ')}]: ${r.summary}`)
      await interaction.editReply(`過去の記録（タグ: ${tag}）:\n${lines.join('\n')}`)
    } catch (err) {
      console.error(err)
      await interaction.editReply('検索中にエラーが発生しました。')
    }
  }

  if (commandName === 'report') {
    await interaction.deferReply()
    try {
      const q = `SELECT created_at, summary, tags, content FROM journals ORDER BY created_at DESC LIMIT 50`
      const res = await pool.query(q)
      console.log(`/report requested: ${res.rows.length} rows fetched.`)
      if (res.rows.length === 0) {
        await interaction.editReply('記録がありません。')
        return
      }
      const report = await generateWeeklyReport(res.rows)
      if (!report) {
        console.error('generateWeeklyReport returned empty string for /report. Falling back to local report.')
        await interaction.editReply('レポート生成中にエラーが発生しました。ただし、データの取得には成功しました。')
        return
      }
      await interaction.editReply(report)
    } catch (err) {
      console.error(err)
      await interaction.editReply('レポート生成中にエラーが発生しました。')
    }
  }
})

// --- 自動検知ハンドラ ---
function shouldRecordMessage(text) {
  if (!text || text.length < 5) return false
  const lower = text.toLowerCase()
  const errorKeywords = /(error|エラー|exception|failed|失敗|ハマっ|直っ|stack|stacktrace|trace|crash|panic)/i
  const codeFence = /```[\s\S]*?```/m
  const inlineCode = /`[^`]+`/m
  const techHints = /(npm|pip|docker|postgres|psql|sequelize|python|javascript|node|react|next|sql|bash)/i

  if (codeFence.test(text) || inlineCode.test(text)) return true
  if (errorKeywords.test(text)) return true
  if (techHints.test(text) && text.length < 500) return true
  return false
}

function extractTags(text) {
  const techs = ['Python','JavaScript','Node.js','Docker','Postgres','PostgreSQL','Sequelize','SQL','React','Next.js','dotenv']
  const tags = []
  for (const t of techs) {
    const key = t.toLowerCase().replace('.', '\\.')
    const re = new RegExp(key, 'i')
    if (re.test(text)) tags.push(normalizeTag(t))
  }
  return tags
}

function normalizeTag(tag) {
  return tag.trim().toLowerCase().replace(/\.+$/, '')
}

client.on('messageCreate', async (message) => {
  try {
    if (message.author?.bot) return
    if (!message.guild) return // only guild messages

    const content = message.content || ''
    if (!shouldRecordMessage(content)) return

    const summary = content.length > 280 ? content.slice(0, 277) + '...' : content
    const aiTags = await generateTags(content)
    const fallbackTags = extractTags(content)
    const rawTags = aiTags.length ? aiTags : fallbackTags
    const tags = [...new Set(rawTags.map((tag) => normalizeTag(tag)).filter(Boolean))]
    const aiSummary = await summarizeEntry(content)

    const q = `INSERT INTO journals (user_id, content, summary, tags, source) VALUES ($1,$2,$3,$4,$5)`
    await pool.query(q, [message.author.id, content, aiSummary || summary, tags, 'discord'])
    console.log('Recorded journal from', message.author.tag, 'tags:', tags)
  } catch (err) {
    console.error('Failed to record message:', err)
  }
})

client.login(process.env.DISCORD_TOKEN)

const port = process.env.PORT || 3000
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('OK')
    return
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not Found')
})

server.listen(port, () => {
  console.log(`Server listening on port ${port}`)
})
