import { useId } from 'react'
import type { CompanionMood } from '../../shared/contracts'

export function Character({ mood = 'idle', small = false }: { mood?: CompanionMood; small?: boolean }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg className={`character character--${mood}${small ? ' character--small' : ''}`}
      viewBox="0 0 120 116" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="27" y1="16" x2="94" y2="102" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFBB83" /><stop offset=".5" stopColor="#F58A53" /><stop offset="1" stopColor="#D96236" />
        </linearGradient>
      </defs>
      <ellipse className="character-shadow" cx="60" cy="105" rx="28" ry="4" fill="#301B10" fillOpacity=".14" />
      <g className="character-body">
        <path d="M61 13C71 7 80 15 83 25C98 22 108 33 103 48C115 58 109 75 98 80C97 96 82 105 69 96C57 107 41 101 36 90C20 93 10 80 16 65C5 52 13 37 27 34C26 19 42 10 54 17L61 13Z"
          fill={`url(#${id})`} stroke="#B95332" strokeOpacity=".18" />
        <path d="M34 28C40 21 48 22 52 24" stroke="#FFDCC0" strokeWidth="4" strokeLinecap="round" opacity=".7" />
        <rect x="31" y="43" width="59" height="35" rx="17.5" fill="#3C2B27" />
        <rect x="33" y="45" width="55" height="31" rx="15.5" stroke="#231E1B" strokeOpacity=".25" />
        <g className="character-eyes">
          <rect x="46" y="53" width="7" height="14" rx="3.5" fill="#FFF7E9" />
          <rect x="68" y="53" width="7" height="14" rx="3.5" fill="#FFF7E9" />
        </g>
        <ellipse cx="27" cy="66" rx="5" ry="3" fill="#C65436" opacity=".3" />
        <ellipse cx="94" cy="66" rx="5" ry="3" fill="#C65436" opacity=".3" />
        <path d="M56 86Q61 90 66 86" stroke="#AD4B2F" strokeWidth="2.5" strokeLinecap="round" />
      </g>
      <path className="character-spark" d="M104 9V21M98 15H110" stroke="#F3B86E" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}
