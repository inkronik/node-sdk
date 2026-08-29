export const runtime = 'edge'

export const GET = (): Response => Response.json({ runtime: 'edge' })
