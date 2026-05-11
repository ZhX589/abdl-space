interface RadarChartProps {
  dimensions: {
    absorption_score: { avg: number; count: number }
    fit_score: { avg: number; count: number }
    comfort_score: { avg: number; count: number }
    thickness_score: { avg: number; count: number }
    appearance_score: { avg: number; count: number }
    value_score: { avg: number; count: number }
  }
  size?: number
}

const LABELS: Record<string, string> = {
  absorption_score: '吸收力',
  fit_score: '贴合度',
  comfort_score: '舒适感',
  thickness_score: '轻薄度',
  appearance_score: '外观',
  value_score: '性价比',
}

/** 六维雷达图组件（SVG 实现） */
export function RadarChart({ dimensions, size = 200 }: RadarChartProps) {
  const dims = Object.entries(dimensions)
  const cx = size / 2
  const cy = size / 2
  const radius = size * 0.35
  const levels = 5

  const angleStep = (2 * Math.PI) / dims.length

  function getPoint(level: number, i: number): [number, number] {
    const r = (radius / levels) * level
    const angle = angleStep * i - Math.PI / 2
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)]
  }

  const gridPaths = Array.from({ length: levels }, (_, level) => {
    const lvl = level + 1
    const pts = dims.map((_, i) => getPoint(lvl, i))
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${p[1]}`).join(' ') + 'Z'
    return <path key={`grid-${lvl}`} d={d} fill="none" stroke="rgba(128,128,128,0.15)" strokeWidth="1" />
  })

  const axisLines = dims.map((_, i) => {
    const [x, y] = getPoint(levels, i)
    return <line key={`axis-${i}`} x1={cx} y1={cy} x2={x} y2={y} stroke="rgba(128,128,128,0.15)" strokeWidth="1" />
  })

  const labels = dims.map(([, val], i) => {
    const [x, y] = getPoint(levels + 0.6, i)
    return (
      <text key={`label-${i}`} x={x} y={y} textAnchor="middle" dominantBaseline="middle" className="fill-[var(--text-secondary)] text-[10px]">
        {LABELS[val.avg !== undefined ? Object.keys(dimensions)[i] : Object.keys(dimensions)[i]] ?? ''}
      </text>
    )
  })

  const dataPath = (() => {
    const pts = dims.map(([, val], i) => {
      const score = val.avg || 0
      const r = (radius / 10) * score
      const angle = angleStep * i - Math.PI / 2
      return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)] as [number, number]
    })
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${p[1]}`).join(' ') + 'Z'
  })()

  const dataPoints = dims.map(([, val], i) => {
    const score = val.avg || 0
    const r = (radius / 10) * score
    const angle = angleStep * i - Math.PI / 2
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)] as [number, number]
  })

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {gridPaths}
        {axisLines}
        <path d={dataPath} fill="rgba(91,163,230,0.2)" stroke="var(--color-primary)" strokeWidth="2" />
        {dataPoints.map(([x, y], i) => (
          <circle key={`dot-${i}`} cx={x} cy={y} r="3" fill="var(--color-primary)" />
        ))}
        {labels}
      </svg>
    </div>
  )
}
