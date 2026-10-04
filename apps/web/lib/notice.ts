/**
 * The privacy notice a business gives its own customers under the DPDP Act, in English and Hindi.
 * What it says comes from the agents the business has switched on, so it never claims more or less
 * than Kritvia actually does with their data.
 */
export type Lang = "en" | "hi";

export interface NoticeData {
  business_name: string;
  city: string;
  contact_name: string;
  contact_email: string;
  kind: string;
  workflows: string[];
  updated_at: string;
}

interface Item {
  what: Record<Lang, string>;
  why: Record<Lang, string>;
  local?: boolean; // processed only on servers in India, never by an outside AI model
}

const ITEMS: Record<string, Item> = {
  inbox_assistant: {
    what: {
      en: "Emails and WhatsApp messages you send us: your name, email address or phone number, and what you write.",
      hi: "आप हमें जो ईमेल और WhatsApp संदेश भेजते हैं: आपका नाम, ईमेल पता या फ़ोन नंबर, और आपने क्या लिखा।",
    },
    why: {
      en: "To understand your message, reply to you and keep a record of our conversation.",
      hi: "आपका संदेश समझने, आपको जवाब देने और हमारी बातचीत का रिकॉर्ड रखने के लिए।",
    },
  },
  lead_triage: {
    what: {
      en: "Enquiries you send through our website, email or forms: name, company, contact details, what you need and your budget.",
      hi: "हमारी वेबसाइट, ईमेल या फ़ॉर्म से भेजी गई पूछताछ: नाम, कंपनी, संपर्क विवरण, आपकी ज़रूरत और बजट।",
    },
    why: {
      en: "To respond with a quote or proposal and to arrange a call if you want one.",
      hi: "आपको कोटेशन या प्रस्ताव भेजने और आप चाहें तो कॉल तय करने के लिए।",
    },
  },
  loan_verification: {
    what: {
      en: "Loan application documents: identity and address proof, income records and bank statements.",
      hi: "लोन आवेदन के दस्तावेज़: पहचान और पते का प्रमाण, आय के रिकॉर्ड और बैंक स्टेटमेंट।",
    },
    why: {
      en: "To check your application against the lender's requirements and tell you what is missing.",
      hi: "आपके आवेदन को लेंडर की शर्तों से मिलाने और यह बताने के लिए कि क्या कमी है।",
    },
    local: true,
  },
  meeting_digest: {
    what: {
      en: "Recordings and notes of meetings and calls with you.",
      hi: "आपके साथ हुई मीटिंग और कॉल की रिकॉर्डिंग और नोट्स।",
    },
    why: {
      en: "To keep accurate notes and follow up on what was agreed.",
      hi: "सही नोट्स रखने और जो तय हुआ उस पर आगे काम करने के लिए।",
    },
  },
};

const T = {
  title: { en: "Privacy notice", hi: "गोपनीयता सूचना" },
  intro: {
    en: (b: string, c: string) =>
      `${b}${c ? `, ${c},` : ""} decides how your personal data is used, under India's Digital Personal Data Protection Act, 2023. This notice says what we collect, why, who helps us process it, and how to use your rights.`,
    hi: (b: string, c: string) =>
      `${b}${c ? `, ${c},` : ""} भारत के डिजिटल व्यक्तिगत डेटा संरक्षण अधिनियम, 2023 के तहत तय करता है कि आपका व्यक्तिगत डेटा कैसे इस्तेमाल हो। यह सूचना बताती है कि हम क्या जानकारी लेते हैं, क्यों, उसे संभालने में कौन मदद करता है, और आप अपने अधिकारों का उपयोग कैसे कर सकते हैं।`,
  },
  collectH: { en: "What we collect and why", hi: "हम क्या जानकारी लेते हैं और क्यों" },
  general: {
    what: {
      en: "Details you share with us: your name, contact details and what you tell us.",
      hi: "आप जो जानकारी हमें देते हैं: आपका नाम, संपर्क विवरण और आपकी बात।",
    },
    why: { en: "To serve you and reply to you.", hi: "आपकी सेवा करने और आपको जवाब देने के लिए।" },
  },
  localNote: {
    en: "Processed only on servers in India; never sent to an outside AI service.",
    hi: "सिर्फ़ भारत के सर्वरों पर प्रोसेस होता है; किसी बाहरी AI सेवा को नहीं भेजा जाता।",
  },
  howH: { en: "How it is handled", hi: "इसे कैसे संभाला जाता है" },
  how: {
    en: [
      "We use Kritvia, a software service by Sitelytc Digital Media Pvt. Ltd., to store our records and draft replies. It processes your data only on our instructions and stores it in India.",
      "AI helps draft replies and summaries, but a person at our business approves what is sent to you. The AI providers involved do not use your data to train their models.",
      "Identity, bank and card numbers are processed only on servers in India.",
      "We keep your data only as long as we need it for the purpose above or as the law requires, then delete it.",
    ],
    hi: [
      "हम अपने रिकॉर्ड रखने और जवाब तैयार करने के लिए Kritvia का उपयोग करते हैं, जो Sitelytc Digital Media Pvt. Ltd. की सॉफ़्टवेयर सेवा है। यह आपका डेटा सिर्फ़ हमारे निर्देश पर प्रोसेस करती है और भारत में रखती है।",
      "AI जवाब और सारांश तैयार करने में मदद करता है, लेकिन आपको जो भेजा जाता है उसे हमारे व्यवसाय का कोई व्यक्ति मंज़ूर करता है। इसमें शामिल AI प्रदाता आपके डेटा से अपने मॉडल नहीं सिखाते।",
      "पहचान, बैंक और कार्ड नंबर सिर्फ़ भारत के सर्वरों पर प्रोसेस होते हैं।",
      "हम आपका डेटा उतने ही समय रखते हैं जितना ऊपर बताए उद्देश्य या कानून के लिए ज़रूरी है, फिर उसे हटा देते हैं।",
    ],
  },
  rightsH: { en: "Your rights", hi: "आपके अधिकार" },
  rights: {
    en: [
      "Ask what personal data we hold about you and how we use it.",
      "Ask us to correct, complete or update it.",
      "Ask us to erase it, unless the law requires us to keep it.",
      "Withdraw your consent at any time; we then stop using your data for that purpose.",
      "Nominate someone to use these rights for you if you die or cannot act.",
      "Complain to us; if we do not resolve it, complain to the Data Protection Board of India.",
    ],
    hi: [
      "पूछें कि हमारे पास आपका कौन-सा व्यक्तिगत डेटा है और हम उसका उपयोग कैसे करते हैं।",
      "हमसे उसे सुधारने, पूरा करने या अपडेट करने को कहें।",
      "उसे हटाने को कहें, जब तक कि कानून हमें उसे रखने को न कहे।",
      "अपनी सहमति कभी भी वापस लें; तब हम उस उद्देश्य के लिए आपके डेटा का उपयोग बंद कर देंगे।",
      "किसी व्यक्ति को नामित करें जो आपकी मृत्यु या असमर्थता में आपके लिए ये अधिकार इस्तेमाल करे।",
      "हमसे शिकायत करें; अगर हम समाधान न करें, तो भारतीय डेटा संरक्षण बोर्ड से शिकायत करें।",
    ],
  },
  contactH: { en: "Contact", hi: "संपर्क" },
  contact: {
    en: (n: string) => `For any question, request or complaint about your data, write to ${n || "us"}:`,
    hi: (n: string) => `अपने डेटा के बारे में किसी भी सवाल, अनुरोध या शिकायत के लिए ${n || "हमें"} लिखें:`,
  },
  reply: {
    en: "We reply within 30 days at the latest.",
    hi: "हम अधिकतम 30 दिनों में जवाब देते हैं।",
  },
  updated: { en: "Last updated", hi: "अंतिम अपडेट" },
  other: { en: "हिन्दी में पढ़ें", hi: "Read in English" },
  poweredBy: { en: "Notice published with Kritvia", hi: "Kritvia के साथ प्रकाशित सूचना" },
} as const;

export function noticeItems(d: Pick<NoticeData, "workflows">, lang: Lang): { what: string; why: string; local: boolean }[] {
  const items = d.workflows.map((w) => ITEMS[w]).filter((x): x is Item => Boolean(x));
  if (items.length === 0) return [{ what: T.general.what[lang], why: T.general.why[lang], local: false }];
  return items.map((i) => ({ what: i.what[lang], why: i.why[lang], local: Boolean(i.local) }));
}

export function noticeText(d: NoticeData, lang: Lang) {
  return {
    title: T.title[lang],
    intro: T.intro[lang](d.business_name, d.city),
    collectH: T.collectH[lang],
    items: noticeItems(d, lang),
    localNote: T.localNote[lang],
    howH: T.howH[lang],
    how: T.how[lang],
    rightsH: T.rightsH[lang],
    rights: T.rights[lang],
    contactH: T.contactH[lang],
    contact: T.contact[lang](d.contact_name),
    reply: T.reply[lang],
    updated: T.updated[lang],
    other: T.other[lang],
    poweredBy: T.poweredBy[lang],
  };
}
