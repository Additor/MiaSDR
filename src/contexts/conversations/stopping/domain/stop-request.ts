/** Lines a mail client quoted from an earlier message, and everything after an "On ... wrote:" marker. */
export function stripQuoted(text: string): string {
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*On .{5,200} wrote:\s*$/.test(line) || /^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

/** `\\b` only knows ASCII letters, so a word with an accent or an umlaut needs its edges spelled out. */
const word = (source: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`, "iu");

/**
 * The one reading of a stop request. Ingest stores it as `raw.stopAsked`, and `replyAskedToStopSql` reads that flag, so
 * SQL holds no copy of these patterns. A false match costs a person one look, and a miss keeps mailing someone who
 * asked to stop, so a pattern stays broad as long as ordinary polite text does not match it. Each one needs a word for
 * mail or contact next to the refusal, because in these languages the refusal alone is common.
 */
const PATTERNS: readonly RegExp[] = [
  // English
  /\bunsubscribe\b/i,
  /\bremove (me|us|my (e-?mail|address))\b/i,
  /\btake (me|us) off\b/i,
  /\bdo not (contact|email|e-mail) (me|us)\b/i,
  /\bdon'?t (contact|email|e-mail) (me|us)\b/i,
  /\bstop (emailing|e-mailing|contacting|sending|messaging)\b/i,
  /\bno more (e-?mails?|messages)\b/i,
  /\bopt[ -]?out\b/i,
  // Korean
  /수신\s*(?:을\s*)?거부/,
  /구독\s*(?:을\s*)?(?:취소|해지)/,
  /연락\s*(?:을\s*)?(?:(?:하지|주지)\s*(?:마|말)|마세요|마십시오|그만)/,
  /(?:메일|메시지|문자|광고)\s*(?:을|를|은|는|도)?\s*(?:더\s*이상\s*|그만\s*)?(?:보내지|발송하지)\s*(?:마|말)/,
  /더\s*이상\s*(?:보내지|연락하지)\s*(?:마|말)/,
  /그만\s*(?:좀\s*)?보내/,
  /(?:명단|목록|리스트)에서\s*(?:저를?\s*)?(?:삭제|빼|제외)/,
  // Japanese
  /配信(?:を)?(?:停止|解除)/,
  /(?:購読|登録|メルマガ)(?:を)?(?:解除|停止)/,
  /(?:連絡|メール|メッセージ)(?:を|は)?(?:もう|今後)?(?:しないで|送らないで|送信しないで)/,
  /(?:もう|今後|二度と)(?:送らないで|送信しないで|連絡しないで)/,
  /(?:今後|もう)(?:の)?(?:ご?連絡|メール|メッセージ)(?:は|を)?(?:不要|結構)/,
  /(?:ご?連絡|メール)(?:は|を)?(?:お断り|ご遠慮)/,
  // Spanish
  word("(?:dar|darme|darnos|darse|dame|denme|den)\\s+de\\s+baja"),
  word("no\\s+(?:me|nos)\\s+(?:contacte|contacten|contactes|escriba|escriban|escribas|env[ií]e|env[ií]en|mande|manden)"),
  word("dej(?:e|en|a|ar|ad)\\s+de\\s+(?:enviar|escribir|contactar|mandar)"),
  word("cancelar\\s+(?:mi\\s+|la\\s+)?suscripci[oó]n"),
  word("no\\s+(?:quiero|deseo|queremos|deseamos)\\s+recibir"),
  word("(?:elim[ií]n|qu[ií]t|b[oó]rr|s[aá]qu)(?:e|en)(?:me|nos)\\s+de"),
  word("(?:eliminar|quitar|borrar|sacar)(?:me|nos)\\s+de"),
  // German
  word("abbestellen"),
  word("(?:aus|von|vom)\\s+(?:\\S+\\s+){0,2}(?:verteiler|mailingliste|newsletter)"),
  word("(?:melden|tragen)\\s+sie\\s+(?:mich|uns)\\s+(?:bitte\\s+)?(?:\\S+\\s+){0,3}(?:ab|aus)"),
  word("(?:kontaktieren|schreiben|mailen|anschreiben)\\s+sie\\s+(?:mich|mir|uns)\\s+(?:bitte\\s+)?(?:nicht\\s+mehr|nicht)(?=\\s*[.!,]|\\s*$)"),
  word("(?:mich|mir|uns)\\s+(?:bitte\\s+)?nicht\\s+mehr\\s+(?:kontaktieren|anschreiben|schreiben|mailen)"),
  word("keine\\s+(?:weiteren?\\s+)?(?:e-?mails?|mails?|nachrichten)\\s+mehr"),
  word("keine\\s+weiteren?\\s+(?:e-?mails?|mails?|nachrichten)"),
  word("(?:senden|schicken)\\s+sie\\s+(?:mir|uns)\\s+(?:bitte\\s+)?keine"),
  // French
  word("d[eé]sabonn\\S*"),
  word("d[eé]sinscri\\S*"),
  word("ne\\s+(?:me|nous)\\s+(?:contactez|[eé]crivez|envoyez|sollicitez|relancez)\\s+plus"),
  word("ne\\s+plus\\s+(?:recevoir|[eê]tre\\s+contact[eé]e?s?|me\\s+contacter)"),
  word("ne\\s+(?:veux|souhaite|voulons|souhaitons)\\s+plus\\s+(?:recevoir|[eê]tre)"),
  word("(?:arr[eê]tez|cessez)\\s+de\\s+(?:m['’]|me\\s+|nous\\s+)(?:envoyer|[eé]crire|contacter|solliciter|relancer)"),
  word("(?:retirez|supprimez|enlevez)[- ](?:moi|nous)"),
];

/**
 * True when the sender's own words ask us to stop. It only raises a flag for a person; nothing is suppressed from here.
 * Mail from a Mac can spell Korean in decomposed jamo, so the text is composed first.
 */
export function detectsStopRequest(body: string): boolean {
  const own = stripQuoted(body).normalize("NFC");
  return PATTERNS.some((p) => p.test(own));
}
