import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints'
import { Client } from '@notionhq/client'
import fetch from 'node-fetch'
import dotenv from 'dotenv'

dotenv.config()

const notion = new Client({ auth: process.env.NOTION_API_KEY })
const NOTION_DB_ID = process.env.NOTION_DATABASE_ID!
const GITHUB_TOKEN = process.env.GITHUB_TOKEN!

interface Repo {
  full_name: string
  html_url: string
  starredAt: string
}
async function getMaxRank(): Promise<number> {
  const result = await notion.databases.query({
    database_id: NOTION_DB_ID,
    sorts: [
      {
        property: 'Rank',
        direction: 'descending',
      },
    ],
    page_size: 1, // 最大値だけで良いので1件取得
  })

  const page = result.results[0]
  if (!page) return 0

  const rankProp = (page as any).properties?.Rank
  const rankValue = rankProp?.number

  return typeof rankValue === 'number' ? rankValue : 0
}

async function fetchStarredRepos(): Promise<Repo[]> {
  const query = `
    query {
      viewer {
        starredRepositories(first: 50, orderBy: { field: STARRED_AT, direction: DESC }) {
          edges {
            starredAt
            node {
              nameWithOwner
              url
            }
          }
        }
      }
    }
  `

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  })

  const data = await res.json()

  const edges = data.data.viewer.starredRepositories.edges

  return edges.map((edge: any) => ({
    full_name: edge.node.nameWithOwner,
    html_url: edge.node.url,
    starredAt: edge.starredAt,
  }))
}

function isToday(dateStr: string): boolean {
  const starredDate = new Date(dateStr)
  const now = new Date()

  return (
    starredDate.getFullYear() === now.getFullYear() &&
    starredDate.getMonth() === now.getMonth() &&
    starredDate.getDate() === now.getDate()
  )
}

function getTodayDate(): string {
  return new Date().toISOString().split('T')[0]
}

async function getExistingPage(): Promise<string | null> {
  const today = getTodayDate()
  const result = await notion.databases.query({
    database_id: NOTION_DB_ID,
    filter: {
      property: 'Date',
      date: {
        equals: today,
      },
    },
  })

  if (result.results.length > 0) {
    return result.results[0].id
  }
  return null
}

async function getRepoLinksFromPage(pageId: string): Promise<string[]> {
  const blocks = await notion.blocks.children.list({ block_id: pageId })

  return blocks.results
    .filter((block: any) => block.type === 'bulleted_list_item')
    .map((block: any) => {
      const richText = block.bulleted_list_item?.rich_text
      const first = richText?.[0]
      return first?.type === 'text' && first.text.link?.url ? first.text.link.url : ''
    })
    .filter(Boolean)
}

function getSlugDate(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

async function createOrUpdatePage(repos: Repo[]) {
  const today = getTodayDate()
  const existingPageId = await getExistingPage()
  let existingLinks: string[] = []
  if (existingPageId) {
    existingLinks = await getRepoLinksFromPage(existingPageId)
  }

  const newRepos = repos.filter((repo) => !existingLinks.includes(repo.html_url))

  if (newRepos.length === 0) {
    console.log('新しいスターはありません。')
    return
  }

  const children: BlockObjectRequest[] = newRepos.map((repo) => ({
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: {
      rich_text: [
        {
          type: 'text',
          text: {
            content: `${repo.full_name}`,
            link: { url: repo.html_url },
          },
        },
      ],
    },
  }))

  if (existingPageId) {
    for (const block of children) {
      await notion.blocks.children.append({
        block_id: existingPageId,
        children: [block],
      })
    }
    console.log('既存ページに追記しました。')
  } else {
    const slug = getSlugDate()
    const nextRank = (await getMaxRank()) + 1
    await notion.pages.create({
      parent: { database_id: NOTION_DB_ID },
      properties: {
        Page: {
          title: [{ text: { content: `Github Starred Activity Report - ${today}` } }],
        },
        Date: {
          date: { start: today },
        },
        Published: {
          checkbox: true,
        },
        Tags: {
          multi_select: [{ name: 'GitHub' }],
        },
        Rank: {
          number: nextRank,
        },
        Slug: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: slug,
              },
            },
          ],
        },
      },
      children,
    })
    console.log('新しい日報ページを作成しました。')
  }
}

async function main() {
  try {
    const repos = await fetchStarredRepos()
    const allRepos = await fetchStarredRepos()
    const todayRepos = allRepos.filter((repo) => isToday(repo.starredAt))
    await createOrUpdatePage(todayRepos)
  } catch (err) {
    console.error('エラー:', err)
  }
}

main()
