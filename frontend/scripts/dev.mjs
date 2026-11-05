// 开发模式：启动 Vite 开发服务器，再启动 Electron 加载它；关闭窗口时一起退出。
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import electronPath from 'electron'

const server = await createServer()
await server.listen()
const url = server.resolvedUrls.local[0]
console.log(`[dev] Vite: ${url}`)

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
})
child.on('exit', async (code) => {
  await server.close()
  process.exit(code ?? 0)
})
