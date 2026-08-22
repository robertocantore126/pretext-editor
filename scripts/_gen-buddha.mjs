import fs from 'fs'

const p1 = 'Buddhism , [a] also known as Buddhadharma and Dharmavinaya (transl. "doctrines and disciplines") , is an Indian religion and philosophy [b] based on teachings attributed to the Buddha , a śramaṇa and religious teacher who lived in the 6th or 5th century BCE . [7] It is the world\'s fourth-largest religion , [8] [9] with about 320 million followers , known as Buddhists , who comprise 4.1% of the global population . [10] It originated in the eastern Gangetic plain as a śramaṇa movement in the 5th century BCE , and gradually spread throughout much of Asia via the Silk Road . Buddhism has since played a significant role in Asian culture and spirituality , eventually spreading to the West in the 20th century .'
const p2 = 'According to tradition, the Buddha taught a path of cultivation that leads to awakening and liberation from dukkha (often translated as "suffering" unsatisfactoriness) by attaining nirvana, the blowing out of the passions. He regarded this path as a Middle Way between extreme asceticism and sensory indulgence, and also between the extremes of eternalism and nihilism. Teaching that dukkha arises alongside attachment or clinging, the Buddha advised meditation practices and ethical precepts rooted in non-harming. Widely observed teachings include the Four Noble Truths, the Noble Eightfold Path, and the doctrines of dependent origination, karma, and the three marks of existence. Other commonly observed elements include the Triple Gem, the taking of monastic vows, and the cultivation of perfections pāramitā.'

const def = { fontFamily: '"Georgia", serif', fontSize: 17, fontWeight: 400, italic: false, underline: false, strike: false, color: '#000000', background: null, letterSpacing: 0, baseline: 'normal', linkHref: null, headline: false }
const link = { ...def, linkHref: 'https://example.com' }

// per-word alternating style ids -> many run boundaries (like Wikipedia links)
function altIds(text) {
  const ids = new Array(text.length).fill(0)
  const tokens = text.split(/(\s+)/)
  let pos = 0
  let s = 0
  for (const t of tokens) {
    for (let i = 0; i < t.length; i++) ids[pos + i] = s
    pos += t.length
    s = 1 - s
  }
  return ids
}

const doc = {
  version: 2,
  paragraphs: [p1, p2],
  styleTable: [def, link],
  styleIds: [altIds(p1), altIds(p2).fill(0)],
  blockAttrs: [
    { kind: 'paragraph', align: 'left', indentLeft: 0, indentRight: 0, indentFirstLine: 0, spaceBefore: 0, spaceAfter: 0, lineHeight: null, list: null },
    { kind: 'paragraph', align: 'justify', indentLeft: 0, indentRight: 0, indentFirstLine: 0, spaceBefore: 0, spaceAfter: 0, lineHeight: null, list: null },
  ],
  images: [],
}
fs.writeFileSync('scripts/_buddha-doc.json', JSON.stringify(doc, null, 2))
console.log('wrote scripts/_buddha-doc.json')
