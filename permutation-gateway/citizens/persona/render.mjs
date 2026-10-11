// The persona block of the system prompt and of the card (contract §2.1, §5.5): name, creed, temperament as
// five words, ambition and goals. Prompt text is English (reasoning language); the card carries both languages.
//
//   renderPersona(persona, lang = 'en') -> string
//   temperamentWord(v) -> 'very low' | 'low' | 'moderate' | 'high' | 'very high'
//
// `persona` = deal.mjs personaOf(entry) plus optional `name` ({en, ja}) and `nation` ({en, ja}).
// Every string passes the sanitiser stand-in (memory/safe.mjs). Nothing here names a pact, a promise or an alliance.
import { safeText } from '../memory/safe.mjs';

const WORDS = {
  en: ['very low', 'low', 'moderate', 'high', 'very high'],
  ja: ['とても低い', '低い', 'ふつう', '高い', 'とても高い'],
};
export const temperamentWord = (v, lang = 'en') => WORDS[lang === 'ja' ? 'ja' : 'en'][Math.min(4, Math.max(0, Math.floor(v / 20)))];

const TRAIT_LABEL = {
  en: { aggression: 'aggression', loyalty: 'loyalty', ambition: 'ambition', honesty: 'honesty', risk: 'risk', sociability: 'sociability', grudge: 'grudge' },
  ja: { aggression: '攻撃性', loyalty: '忠誠', ambition: '野心', honesty: '誠実さ', risk: '危険を取る度合い', sociability: '社交性', grudge: '根に持つ度合い' },
};

export function renderPersona(persona, lang = 'en') {
  const l = lang === 'ja' ? 'ja' : 'en';
  const s = x => safeText(x, { kind: 'trusted' });
  const name = persona.name?.[l] ?? '';
  const nation = persona.nation?.[l] ?? '';
  const temper = Object.keys(TRAIT_LABEL.en).filter(k => k in persona.temperament)
    .map(k => `${TRAIT_LABEL[l][k]} ${temperamentWord(persona.temperament[k], l)}`).join(l === 'ja' ? '、' : ', ');
  const goals = persona.goals.map(g => `${g.id} ${g.text[l]}`);
  const head = l === 'ja'
    ? [name && `あなたは${name}。${nation ? `${nation}の` : ''}AI市民です。`, `志：${persona.ambition[l]}`, `信条：「${persona.creed[l]}」`, `気質：${temper}`, '目標：']
    : [name && `You are ${name}, an AI citizen${nation ? ` of ${nation}` : ''}.`, `Ambition: ${persona.ambition[l]}.`, `Creed: "${persona.creed[l]}"`, `Temperament: ${temper}.`, 'Goals:'];
  return [...head.filter(Boolean), ...goals].map(s).join('\n');
}
