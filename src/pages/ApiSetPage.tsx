import { useState, useEffect } from 'react'
import { getApiKeys, setApiKey, deleteApiKey, type ApiKeyItem } from '../lib/api.ts'

const PROVIDER_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  anthropic: 'Anthropic'
}

export function ApiSetPage() {
  const [keys, setKeys] = useState<ApiKeyItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [selectedProvider, setSelectedProvider] = useState('deepseek')
  const [keyValue, setKeyValue] = useState('')
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => {
    loadKeys()
  }, [])

  function loadKeys() {
    const token = localStorage.getItem('token')
    if (!token) { setError('请先登录'); setLoading(false); return }
    setLoading(true)
    setError(null)
    getApiKeys(token)
      .then(data => setKeys(data.keys))
      .catch(e => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false))
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!keyValue.trim()) return
    const token = localStorage.getItem('token')
    if (!token) { setError('请先登录'); return }
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      await setApiKey({ provider: selectedProvider, key_value: keyValue.trim(), label: label.trim() || undefined }, token)
      setSuccess(`${PROVIDER_LABELS[selectedProvider]} API Key 已保存`)
      setKeyValue('')
      setLabel('')
      loadKeys()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(provider: string) {
    if (!confirm(`确定删除 ${PROVIDER_LABELS[provider] || provider} 的 API Key？`)) return
    const token = localStorage.getItem('token')
    if (!token) { setError('请先登录'); return }
    setDeleting(provider)
    setError(null)
    setSuccess(null)
    try {
      await deleteApiKey(provider, token)
      setSuccess('已删除')
      loadKeys()
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败')
    } finally {
      setDeleting(null)
    }
  }

  const existing = keys.find(k => k.provider === selectedProvider)

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">API Key 设置</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          管理员可在此设置第三方 AI 服务的 API Key，用于驱动 AI 推荐等功能
        </p>
      </div>

      {error && <div className="glass mb-4 px-4 py-2 text-sm text-[var(--color-accent)]">{error}</div>}
      {success && <div className="glass mb-4 px-4 py-2 text-sm text-[var(--color-primary)]">{success}</div>}

      <div className="glass mb-6 p-6">
        <h2 className="mb-4 text-lg font-bold text-[var(--text-primary)]">设置 API Key</h2>

        <form onSubmit={handleSave} className="space-y-4">
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="mb-1 block text-sm font-medium text-[var(--text-primary)]">服务商</label>
              <select
                value={selectedProvider}
                onChange={e => setSelectedProvider(e.target.value)}
                className="w-full rounded-[var(--radius-sm)] border border-[rgba(0,0,0,0.1)] bg-[var(--bg-page)] px-3 py-2 text-sm text-[var(--text-primary)]"
              >
                {Object.entries(PROVIDER_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-sm font-medium text-[var(--text-primary)]">备注（可选）</label>
              <input
                type="text"
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="如：生产环境 Key"
                className="w-full rounded-[var(--radius-sm)] border border-[rgba(0,0,0,0.1)] bg-[var(--bg-page)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--color-primary)]"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--text-primary)]">
              API Key {existing ? '(已设置，提交将覆盖)' : ''}
            </label>
            <input
              type="password"
              value={keyValue}
              onChange={e => setKeyValue(e.target.value)}
              placeholder="sk-..."
              className="w-full rounded-[var(--radius-sm)] border border-[rgba(0,0,0,0.1)] bg-[var(--bg-page)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--color-primary)]"
            />
          </div>

          <button
            type="submit"
            disabled={saving || !keyValue.trim()}
            className="rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-6 py-2 text-sm font-medium text-[var(--text-on-primary)] transition-all hover:opacity-90 disabled:opacity-40"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </form>
      </div>

      <div className="glass p-6">
        <h2 className="mb-4 text-lg font-bold text-[var(--text-primary)]">已配置的 API Key</h2>

        {loading ? (
          <p className="text-sm text-[var(--text-secondary)]">加载中...</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-[var(--text-secondary)]">暂无已配置的 API Key</p>
        ) : (
          <div className="space-y-3">
            {keys.map(k => (
              <div key={k.id} className="flex items-center justify-between rounded-[var(--radius-sm)] bg-[var(--color-primary-lighter)] p-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[var(--text-primary)]">{PROVIDER_LABELS[k.provider] || k.provider}</span>
                    {k.label && <span className="text-xs text-[var(--text-secondary)]">· {k.label}</span>}
                  </div>
                  <div className="mt-1 text-xs text-[var(--text-secondary)]">
                    已设置 · 更新于 {new Date(k.updated_at).toLocaleString('zh-CN')}
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(k.provider)}
                  disabled={deleting === k.provider}
                  className="rounded-[4px] px-3 py-1 text-xs text-[var(--color-accent)] transition-colors hover:bg-[rgba(255,140,148,0.1)] disabled:opacity-40"
                >
                  {deleting === k.provider ? '删除中...' : '删除'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}