/**
 * What the stop reading must find and must leave alone, for `detectsStopRequest` and for the flag `replyAskedToStopSql`
 * reads after ingest. Both tests walk this one table.
 */
export const STOP_REQUEST_FIXTURES: ReadonlyArray<{ language: string; asks: readonly string[]; ordinary: readonly string[] }> = [
  {
    language: "English",
    asks: ["Please unsubscribe me from this list.", "Stop emailing me.", "Do not contact me again", "Take me off your list", "no more emails please"],
    ordinary: ["Thanks, please contact me on Tuesday.", "I can't stop thinking about your offer.", "Send me more emails about pricing."],
  },
  {
    language: "Korean",
    asks: [
      "수신 거부",
      "수신거부 합니다",
      "연락하지 마세요",
      "앞으로 연락 주지 말아 주세요",
      "그만 보내주세요",
      "메일 보내지 마세요",
      "이메일을 더 이상 보내지 말아주세요",
      "더 이상 보내지 마세요",
      "구독 취소 부탁드립니다",
      "목록에서 삭제해 주세요",
    ],
    ordinary: [
      "거부할 수 없는 제안",
      "연락 주세요",
      "다음 주에 연락 부탁드립니다",
      "메일 보내 주세요",
      "자료 보내지 마시고 통화로 설명해 주세요",
      "걱정하지 마세요. 제가 연락 드리겠습니다.",
      "수신 확인 부탁드립니다",
      "전 직장을 그만두었습니다",
    ],
  },
  {
    language: "Japanese",
    asks: ["配信停止をお願いします", "配信を解除してください", "購読解除", "メールを送らないでください", "もう連絡しないでください", "今後のご連絡は不要です", "営業メールはお断りします"],
    ordinary: ["ご連絡ください", "メールをお送りください", "ご連絡をお待ちしております", "遠慮なくご連絡ください", "返信は不要です", "配信のご案内をありがとうございます"],
  },
  {
    language: "Spanish",
    asks: ["Quiero darme de baja", "Por favor, denme de baja", "No me contacten más", "No me envíen más correos", "Dejen de enviar correos", "Quiero cancelar mi suscripción", "No quiero recibir más mensajes", "Quítenme de la lista"],
    ordinary: ["Escríbame cuando pueda", "No me contactó nadie de su equipo", "Dejé de usar esa herramienta", "Me interesa recibir más información", "No quiero perder la llamada del lunes"],
  },
  {
    language: "German",
    asks: ["Bitte abbestellen", "Bitte nehmen Sie mich aus dem Verteiler", "Melden Sie mich bitte ab.", "Kontaktieren Sie mich nicht mehr.", "Bitte mich nicht mehr kontaktieren", "Ich möchte keine E-Mails mehr erhalten", "Senden Sie mir keine Werbung"],
    ordinary: ["Bitte kontaktieren Sie mich am Montag", "Ich habe keine E-Mail bekommen", "Keine Sorge, schreiben Sie mir gerne", "Ich muss mich leider vom Termin abmelden", "Melden Sie sich gerne bei mir"],
  },
  {
    language: "French",
    asks: ["Je souhaite me désabonner", "Merci de me desinscrire", "Ne me contactez plus", "Je ne veux plus recevoir vos messages", "Arrêtez de m’envoyer des e-mails", "Retirez-moi de votre liste", "Merci de ne plus me contacter"],
    ordinary: ["N'hésitez pas à me contacter", "Contactez-moi la semaine prochaine", "Je ne peux plus vous appeler demain", "Envoyez-moi plus d'informations", "Je souhaite recevoir la présentation"],
  },
];
