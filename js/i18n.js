/**
 * i18n — Internationalization for Silbero.Digital
 *
 * The language choice itself is collected as part of the dossier.
 * Supported: English, Spanish, German, Dutch, Arabic
 */

export const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English', dir: 'ltr' },
  { code: 'es', name: 'Spanish', native: 'Espanol', dir: 'ltr' },
  { code: 'de', name: 'German', native: 'Deutsch', dir: 'ltr' },
  { code: 'nl', name: 'Dutch', native: 'Nederlands', dir: 'ltr' },
  { code: 'ar', name: 'Arabic', native: '\u0627\u0644\u0639\u0631\u0628\u064A\u0629', dir: 'rtl' },
];

const T = {
  en: {
    // Splash
    splashTitle: 'What is Silbero Digital?',
    splashDesc1: 'Silbero Digital is an interactive art installation inspired by the Silbo Gomero whistled language of La Gomera, Canary Islands, and the consequences of social media.',
    splashDesc2: 'Type messages to other participants at this event. Your words are encoded into sound \u2014 a digital whistle that carries your message across the space. Your conversations and camera images are collected as art pieces for sale by the artist at this event.',
    silboTitle: 'What is Silbo Gomero?',
    silboDesc: 'Silbo Gomero is a whistled language developed by the inhabitants of La Gomera to communicate across the deep ravines and narrow valleys of the island. Whistled messages can travel up to 5 kilometers. It was declared a Masterpiece of the Oral and Intangible Heritage of Humanity by UNESCO in 2009.',
    consentData: 'I consent to share my conversation and camera image data with the artist for display and resale at this event.',
    consentDataNote: '(If you uncheck this, your camera will not activate and your messages will not be printed.)',
    consentPrivacy: 'I accept the Privacy Policy and agree not to share personal or sensitive information I wouldn\'t want others to see.',
    privacyLink: 'Privacy Policy',
    letsSilbero: 'LET\'S SILBERO!',
    splashFooter: 'An art installation by Caitlyn Meeks / noodlings.ai',
    orSignIn: 'Or sign in with',
    // Name
    whatsYourName: 'What\'s your name?',
    leaveBlank: 'Leave blank to stay anonymous',
    enter: 'ENTER',
    // Selfie
    selfieTitle: 'TAKE YOUR SILBERO SELFIE',
    selfieGuide: 'Make the Silbo whistle gesture with your hands, like this.',
    capture: 'CAPTURE',
    retake: 'RETAKE',
    usePhoto: 'USE THIS PHOTO',
    skipPhoto: 'Skip (no avatar)',
    cameraUnavailable: 'Camera not available. You can skip this step.',
    // Terminal
    placeholder: 'type a message, press send',
    send: 'SEND',
    // Email prompt
    saveReceipt: 'Save your Silbero receipt?',
    emailPlaceholder: 'your@email.com',
    emailHint: 'We\'ll email you a digital copy of your receipt',
    emailSubmit: 'SAVE',
    emailSkip: 'No thanks',
  },

  es: {
    splashTitle: '\u00bfQu\u00e9 es Silbero Digital?',
    splashDesc1: 'Silbero Digital es una instalaci\u00f3n de arte interactiva inspirada en el lenguaje silbado Silbo Gomero de La Gomera, Islas Canarias, y las consecuencias de las redes sociales.',
    splashDesc2: 'Escribe mensajes a otros participantes en este evento. Tus palabras se codifican en sonido \u2014 un silbido digital que transporta tu mensaje a trav\u00e9s del espacio. Tus conversaciones e im\u00e1genes de c\u00e1mara se recogen como piezas de arte para la venta por el artista en este evento.',
    silboTitle: '\u00bfQu\u00e9 es el Silbo Gomero?',
    silboDesc: 'El Silbo Gomero es un lenguaje silbado desarrollado por los habitantes de La Gomera para comunicarse a trav\u00e9s de los profundos barrancos y estrechos valles de la isla. Los mensajes silbados pueden viajar hasta 5 kil\u00f3metros. Fue declarado Obra Maestra del Patrimonio Oral e Inmaterial de la Humanidad por la UNESCO en 2009.',
    consentData: 'Consiento compartir mis datos de conversaci\u00f3n e imagen de c\u00e1mara con el artista para exhibici\u00f3n y reventa en este evento.',
    consentDataNote: '(Si desmarcas esto, tu c\u00e1mara no se activar\u00e1 y tus mensajes no se imprimir\u00e1n.)',
    consentPrivacy: 'Acepto la Pol\u00edtica de Privacidad y me comprometo a no compartir informaci\u00f3n personal o sensible que no quiera que otros vean.',
    privacyLink: 'Pol\u00edtica de Privacidad',
    letsSilbero: '\u00a1VAMOS A SILBEAR!',
    splashFooter: 'Una instalaci\u00f3n art\u00edstica de Caitlyn Meeks / noodlings.ai',
    orSignIn: 'O inicia sesi\u00f3n con',
    whatsYourName: '\u00bfC\u00f3mo te llamas?',
    leaveBlank: 'D\u00e9jalo en blanco para ser an\u00f3nimo',
    enter: 'ENTRAR',
    selfieTitle: 'HAZTE TU SELFIE SILBERO',
    selfieGuide: 'Haz el gesto de silbar con las manos, as\u00ed.',
    capture: 'CAPTURAR',
    retake: 'REPETIR',
    usePhoto: 'USAR ESTA FOTO',
    skipPhoto: 'Saltar (sin avatar)',
    cameraUnavailable: 'C\u00e1mara no disponible. Puedes saltar este paso.',
    placeholder: 'escribe un mensaje, pulsa enviar',
    send: 'ENVIAR',
    saveReceipt: '\u00bfGuardar tu recibo Silbero?',
    emailPlaceholder: 'tu@email.com',
    emailHint: 'Te enviaremos una copia digital de tu recibo',
    emailSubmit: 'GUARDAR',
    emailSkip: 'No, gracias',
  },

  de: {
    splashTitle: 'Was ist Silbero Digital?',
    splashDesc1: 'Silbero Digital ist eine interaktive Kunstinstallation, inspiriert von der Pfeifsprache Silbo Gomero von La Gomera, Kanarische Inseln, und den Konsequenzen sozialer Medien.',
    splashDesc2: 'Schreibe Nachrichten an andere Teilnehmer dieser Veranstaltung. Deine Worte werden in Klang kodiert \u2014 ein digitaler Pfiff, der deine Nachricht durch den Raum tr\u00e4gt. Deine Gespr\u00e4che und Kamerabilder werden als Kunstwerke zum Verkauf durch den K\u00fcnstler gesammelt.',
    silboTitle: 'Was ist Silbo Gomero?',
    silboDesc: 'Silbo Gomero ist eine Pfeifsprache, die von den Bewohnern La Gomeras entwickelt wurde, um \u00fcber die tiefen Schluchten und engen T\u00e4ler der Insel zu kommunizieren. Gepfiffene Nachrichten k\u00f6nnen bis zu 5 Kilometer weit reichen. Sie wurde 2009 von der UNESCO zum Meisterwerk des m\u00fcndlichen und immateriellen Erbes der Menschheit erkl\u00e4rt.',
    consentData: 'Ich stimme zu, meine Gespr\u00e4chs- und Kamerabilddaten mit dem K\u00fcnstler f\u00fcr Ausstellung und Weiterverkauf bei dieser Veranstaltung zu teilen.',
    consentDataNote: '(Wenn du dies deaktivierst, wird deine Kamera nicht aktiviert und deine Nachrichten werden nicht gedruckt.)',
    consentPrivacy: 'Ich akzeptiere die Datenschutzerkl\u00e4rung und verpflichte mich, keine pers\u00f6nlichen oder sensiblen Informationen zu teilen.',
    privacyLink: 'Datenschutzerkl\u00e4rung',
    letsSilbero: 'LOS GEHT\'S!',
    splashFooter: 'Eine Kunstinstallation von Caitlyn Meeks / noodlings.ai',
    orSignIn: 'Oder anmelden mit',
    whatsYourName: 'Wie hei\u00dft du?',
    leaveBlank: 'Leer lassen f\u00fcr anonym',
    enter: 'WEITER',
    selfieTitle: 'MACH DEIN SILBERO-SELFIE',
    selfieGuide: 'Mach die Silbo-Pfeifgeste mit deinen H\u00e4nden, so.',
    capture: 'AUFNEHMEN',
    retake: 'NEU',
    usePhoto: 'DIESES FOTO VERWENDEN',
    skipPhoto: '\u00dcberspringen (kein Avatar)',
    cameraUnavailable: 'Kamera nicht verf\u00fcgbar. Du kannst diesen Schritt \u00fcberspringen.',
    placeholder: 'Nachricht eingeben, Senden dr\u00fccken',
    send: 'SENDEN',
    saveReceipt: 'Silbero-Beleg speichern?',
    emailPlaceholder: 'deine@email.de',
    emailHint: 'Wir senden dir eine digitale Kopie deines Belegs',
    emailSubmit: 'SPEICHERN',
    emailSkip: 'Nein danke',
  },

  nl: {
    splashTitle: 'Wat is Silbero Digital?',
    splashDesc1: 'Silbero Digital is een interactieve kunstinstallatie ge\u00efnspireerd door de fluittaal Silbo Gomero van La Gomera, Canarische Eilanden, en de gevolgen van sociale media.',
    splashDesc2: 'Typ berichten naar andere deelnemers op dit evenement. Je woorden worden gecodeerd in geluid \u2014 een digitaal fluitje dat je bericht door de ruimte draagt. Je gesprekken en camerabeelden worden verzameld als kunstwerken voor verkoop door de kunstenaar.',
    silboTitle: 'Wat is Silbo Gomero?',
    silboDesc: 'Silbo Gomero is een fluittaal ontwikkeld door de inwoners van La Gomera om te communiceren over de diepe ravijnen en smalle valleien van het eiland. Gefloten berichten kunnen tot 5 kilometer ver reiken. Het werd in 2009 door UNESCO uitgeroepen tot Meesterwerk van het Mondeling en Immaterieel Erfgoed van de Mensheid.',
    consentData: 'Ik stem in om mijn gespreks- en camerabeeldgegevens te delen met de kunstenaar voor vertoning en doorverkoop op dit evenement.',
    consentDataNote: '(Als je dit uitschakelt, wordt je camera niet geactiveerd en worden je berichten niet afgedrukt.)',
    consentPrivacy: 'Ik accepteer het Privacybeleid en beloof geen persoonlijke of gevoelige informatie te delen.',
    privacyLink: 'Privacybeleid',
    letsSilbero: 'LATEN WE SILBERO\'EN!',
    splashFooter: 'Een kunstinstallatie van Caitlyn Meeks / noodlings.ai',
    orSignIn: 'Of log in met',
    whatsYourName: 'Hoe heet je?',
    leaveBlank: 'Laat leeg om anoniem te blijven',
    enter: 'VERDER',
    selfieTitle: 'MAAK JE SILBERO-SELFIE',
    selfieGuide: 'Maak het Silbo-fluitgebaar met je handen, zoals dit.',
    capture: 'VASTLEGGEN',
    retake: 'OPNIEUW',
    usePhoto: 'GEBRUIK DEZE FOTO',
    skipPhoto: 'Overslaan (geen avatar)',
    cameraUnavailable: 'Camera niet beschikbaar. Je kunt deze stap overslaan.',
    placeholder: 'typ een bericht, druk op verzenden',
    send: 'VERZENDEN',
    saveReceipt: 'Silbero-bon opslaan?',
    emailPlaceholder: 'jouw@email.nl',
    emailHint: 'We sturen je een digitale kopie van je bon',
    emailSubmit: 'OPSLAAN',
    emailSkip: 'Nee bedankt',
  },

  ar: {
    splashTitle: '\u0645\u0627 \u0647\u0648 \u0633\u064A\u0644\u0628\u064A\u0631\u0648 \u062F\u064A\u062C\u064A\u062A\u0627\u0644\u061F',
    splashDesc1: '\u0633\u064A\u0644\u0628\u064A\u0631\u0648 \u062F\u064A\u062C\u064A\u062A\u0627\u0644 \u0647\u0648 \u062A\u0631\u0643\u064A\u0628 \u0641\u0646\u064A \u062A\u0641\u0627\u0639\u0644\u064A \u0645\u0633\u062A\u0648\u062D\u0649 \u0645\u0646 \u0644\u063A\u0629 \u0627\u0644\u0635\u0641\u064A\u0631 \u0633\u064A\u0644\u0628\u0648 \u063A\u0648\u0645\u064A\u0631\u0648 \u0645\u0646 \u0644\u0627 \u063A\u0648\u0645\u064A\u0631\u0627\u060C \u062C\u0632\u0631 \u0627\u0644\u0643\u0646\u0627\u0631\u064A\u060C \u0648\u0639\u0648\u0627\u0642\u0628 \u0648\u0633\u0627\u0626\u0644 \u0627\u0644\u062A\u0648\u0627\u0635\u0644 \u0627\u0644\u0627\u062C\u062A\u0645\u0627\u0639\u064A.',
    splashDesc2: '\u0627\u0643\u062A\u0628 \u0631\u0633\u0627\u0626\u0644 \u0625\u0644\u0649 \u0627\u0644\u0645\u0634\u0627\u0631\u0643\u064A\u0646 \u0627\u0644\u0622\u062E\u0631\u064A\u0646. \u064A\u062A\u0645 \u062A\u0631\u0645\u064A\u0632 \u0643\u0644\u0645\u0627\u062A\u0643 \u0625\u0644\u0649 \u0635\u0648\u062A \u2014 \u0635\u0641\u064A\u0631 \u0631\u0642\u0645\u064A \u064A\u0646\u0642\u0644 \u0631\u0633\u0627\u0644\u062A\u0643. \u064A\u062A\u0645 \u062C\u0645\u0639 \u0645\u062D\u0627\u062F\u062B\u0627\u062A\u0643 \u0648\u0635\u0648\u0631 \u0627\u0644\u0643\u0627\u0645\u064A\u0631\u0627 \u0643\u0642\u0637\u0639 \u0641\u0646\u064A\u0629 \u0644\u0644\u0628\u064A\u0639.',
    silboTitle: '\u0645\u0627 \u0647\u0648 \u0633\u064A\u0644\u0628\u0648 \u063A\u0648\u0645\u064A\u0631\u0648\u061F',
    silboDesc: '\u0633\u064A\u0644\u0628\u0648 \u063A\u0648\u0645\u064A\u0631\u0648 \u0647\u064A \u0644\u063A\u0629 \u0635\u0641\u064A\u0631 \u0637\u0648\u0631\u0647\u0627 \u0633\u0643\u0627\u0646 \u0644\u0627 \u063A\u0648\u0645\u064A\u0631\u0627 \u0644\u0644\u062A\u0648\u0627\u0635\u0644 \u0639\u0628\u0631 \u0627\u0644\u0648\u062F\u064A\u0627\u0646 \u0627\u0644\u0639\u0645\u064A\u0642\u0629. \u064A\u0645\u0643\u0646 \u0623\u0646 \u062A\u0635\u0644 \u0627\u0644\u0631\u0633\u0627\u0626\u0644 \u0625\u0644\u0649 \u0665 \u0643\u064A\u0644\u0648\u0645\u062A\u0631\u0627\u062A. \u0623\u0639\u0644\u0646\u062A\u0647\u0627 \u0627\u0644\u064A\u0648\u0646\u0633\u0643\u0648 \u062A\u062D\u0641\u0629 \u0645\u0646 \u0627\u0644\u062A\u0631\u0627\u062B \u0627\u0644\u0634\u0641\u0647\u064A \u0639\u0627\u0645 \u0662\u0660\u0660\u0669.',
    consentData: '\u0623\u0648\u0627\u0641\u0642 \u0639\u0644\u0649 \u0645\u0634\u0627\u0631\u0643\u0629 \u0628\u064A\u0627\u0646\u0627\u062A \u0645\u062D\u0627\u062F\u062B\u0627\u062A\u064A \u0648\u0635\u0648\u0631 \u0627\u0644\u0643\u0627\u0645\u064A\u0631\u0627 \u0645\u0639 \u0627\u0644\u0641\u0646\u0627\u0646 \u0644\u0644\u0639\u0631\u0636 \u0648\u0627\u0644\u0628\u064A\u0639.',
    consentDataNote: '(\u0625\u0630\u0627 \u0623\u0644\u063A\u064A\u062A \u0647\u0630\u0627\u060C \u0644\u0646 \u064A\u062A\u0645 \u062A\u0641\u0639\u064A\u0644 \u0627\u0644\u0643\u0627\u0645\u064A\u0631\u0627 \u0648\u0644\u0646 \u062A\u062A\u0645 \u0637\u0628\u0627\u0639\u0629 \u0631\u0633\u0627\u0626\u0644\u0643.)',
    consentPrivacy: '\u0623\u0642\u0628\u0644 \u0633\u064A\u0627\u0633\u0629 \u0627\u0644\u062E\u0635\u0648\u0635\u064A\u0629 \u0648\u0623\u062A\u0639\u0647\u062F \u0628\u0639\u062F\u0645 \u0645\u0634\u0627\u0631\u0643\u0629 \u0645\u0639\u0644\u0648\u0645\u0627\u062A \u0634\u062E\u0635\u064A\u0629 \u0623\u0648 \u062D\u0633\u0627\u0633\u0629.',
    privacyLink: '\u0633\u064A\u0627\u0633\u0629 \u0627\u0644\u062E\u0635\u0648\u0635\u064A\u0629',
    letsSilbero: '\u0647\u064A\u0627 \u0646\u0628\u062F\u0623!',
    splashFooter: '\u062A\u0631\u0643\u064A\u0628 \u0641\u0646\u064A \u0645\u0646 \u0643\u064A\u062A\u0644\u064A\u0646 \u0645\u064A\u0643\u0633 / noodlings.ai',
    orSignIn: '\u0623\u0648 \u0633\u062C\u0651\u0644 \u0627\u0644\u062F\u062E\u0648\u0644 \u0628\u0640',
    whatsYourName: '\u0645\u0627 \u0627\u0633\u0645\u0643\u061F',
    leaveBlank: '\u0627\u062A\u0631\u0643\u0647 \u0641\u0627\u0631\u063A\u064B\u0627 \u0644\u0644\u0628\u0642\u0627\u0621 \u0645\u062C\u0647\u0648\u0644\u064B\u0627',
    enter: '\u062F\u062E\u0648\u0644',
    selfieTitle: '\u0627\u0644\u062A\u0642\u0637 \u0635\u0648\u0631\u0629 \u0633\u064A\u0644\u0628\u064A\u0631\u0648',
    selfieGuide: '\u0627\u0635\u0646\u0639 \u0625\u0634\u0627\u0631\u0629 \u0627\u0644\u0635\u0641\u064A\u0631 \u0628\u064A\u062F\u064A\u0643\u060C \u0647\u0643\u0630\u0627.',
    capture: '\u0627\u0644\u062A\u0642\u0627\u0637',
    retake: '\u0625\u0639\u0627\u062F\u0629',
    usePhoto: '\u0627\u0633\u062A\u062E\u062F\u0645 \u0647\u0630\u0647 \u0627\u0644\u0635\u0648\u0631\u0629',
    skipPhoto: '\u062A\u062E\u0637\u064A (\u0628\u062F\u0648\u0646 \u0635\u0648\u0631\u0629)',
    cameraUnavailable: '\u0627\u0644\u0643\u0627\u0645\u064A\u0631\u0627 \u063A\u064A\u0631 \u0645\u062A\u0627\u062D\u0629. \u064A\u0645\u0643\u0646\u0643 \u062A\u062E\u0637\u064A \u0647\u0630\u0647 \u0627\u0644\u062E\u0637\u0648\u0629.',
    placeholder: '\u0627\u0643\u062A\u0628 \u0631\u0633\u0627\u0644\u0629\u060C \u0627\u0636\u063A\u0637 \u0625\u0631\u0633\u0627\u0644',
    send: '\u0625\u0631\u0633\u0627\u0644',
    saveReceipt: '\u062D\u0641\u0638 \u0625\u064A\u0635\u0627\u0644 \u0633\u064A\u0644\u0628\u064A\u0631\u0648\u061F',
    emailPlaceholder: 'email@example.com',
    emailHint: '\u0633\u0646\u0631\u0633\u0644 \u0644\u0643 \u0646\u0633\u062E\u0629 \u0631\u0642\u0645\u064A\u0629 \u0645\u0646 \u0625\u064A\u0635\u0627\u0644\u0643',
    emailSubmit: '\u062D\u0641\u0638',
    emailSkip: '\u0644\u0627 \u0634\u0643\u0631\u064B\u0627',
  },
};

let currentLang = 'en';
let currentDir = 'ltr';

/**
 * Set the active language.
 */
export function setLanguage(code) {
  currentLang = code;
  const lang = LANGUAGES.find(l => l.code === code);
  currentDir = lang ? lang.dir : 'ltr';
  document.documentElement.lang = code;
  document.documentElement.dir = currentDir;
}

/**
 * Get a translated string.
 */
export function t(key) {
  return (T[currentLang] && T[currentLang][key]) || T.en[key] || key;
}

/**
 * Get current language code.
 */
export function getLang() {
  return currentLang;
}

/**
 * Get current text direction.
 */
export function getDir() {
  return currentDir;
}
