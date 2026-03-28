import { createContext, useContext, useState, useCallback, useMemo } from 'react';

const STORAGE_KEY = 'su94r-locale';

const locales = [
  { code: 'en', label: 'English', flag: '\u{1F1FA}\u{1F1F8}' },
  { code: 'es', label: 'Espa\u00f1ol', flag: '\u{1F1EA}\u{1F1F8}' },
  { code: 'fr', label: 'Fran\u00e7ais', flag: '\u{1F1EB}\u{1F1F7}' },
  { code: 'pt', label: 'Portugu\u00eas', flag: '\u{1F1E7}\u{1F1F7}' },
  { code: 'de', label: 'Deutsch', flag: '\u{1F1E9}\u{1F1EA}' },
  { code: 'zh', label: '\u4E2D\u6587', flag: '\u{1F1E8}\u{1F1F3}' },
  { code: 'hi', label: '\u0939\u093F\u0928\u094D\u0926\u0940', flag: '\u{1F1EE}\u{1F1F3}' },
  { code: 'ar', label: '\u0627\u0644\u0639\u0631\u0628\u064A\u0629', flag: '\u{1F1F8}\u{1F1E6}' },
  { code: 'ja', label: '\u65E5\u672C\u8A9E', flag: '\u{1F1EF}\u{1F1F5}' },
];

const translations = {
  en: {
    nav: {
      dashboard: 'Dashboard',
      agents: 'Agents',
      trackers: 'Trackers',
      devices: 'Devices',
      settings: 'Settings',
    },
    dashboard: {
      title: 'Dashboard',
      notSynced: 'Not Synced',
      noData: 'No Data',
      collectingReadings: 'Collecting Readings',
      recentReadings: 'Recent Readings',
      noCgm: 'No CGM Connected',
      enableAlerts: 'Enable Alerts',
      hourTrend: 'Hour Trend',
    },
    settings: {
      title: 'Settings',
      cgm: 'CGM',
      ai: 'AI',
      fitness: 'Fitness',
      alerts: 'Alerts',
      profile: 'Profile',
      glucoseSource: 'Glucose Source',
      saveProfil: 'Save Profile',
      dyslexiaFont: 'Dyslexia Font',
      dyslexiaHint: 'Uses OpenDyslexic font for improved readability',
      enableDyslexic: 'Enable Dyslexic Font',
      diabetesType: 'Diabetes Type',
      yourName: 'Your Name',
      glucoseUnit: 'Glucose Unit',
      weightUnit: 'Weight Unit',
      tempUnit: 'Temperature Unit',
    },
    common: {
      save: 'Save',
      cancel: 'Cancel',
      enable: 'Enable',
      stable: 'Stable',
      noData: 'No Data',
    },
    footer: {
      madeBy: 'Made by Ken Wolf with \u{1F49A}',
      company: 'Med Inc',
    },
  },
  es: {
    nav: {
      dashboard: 'Panel',
      agents: 'Agentes',
      trackers: 'Rastreadores',
      devices: 'Dispositivos',
      settings: 'Configuraci\u00f3n',
    },
    dashboard: {
      title: 'Panel',
      notSynced: 'No Sincronizado',
      noData: 'Sin Datos',
      collectingReadings: 'Recopilando Lecturas',
      recentReadings: 'Lecturas Recientes',
      noCgm: 'Sin CGM Conectado',
      enableAlerts: 'Activar Alertas',
      hourTrend: 'Tendencia por Hora',
    },
    settings: {
      title: 'Configuraci\u00f3n',
      cgm: 'MCG',
      ai: 'IA',
      fitness: 'Ejercicio',
      alerts: 'Alertas',
      profile: 'Perfil',
      glucoseSource: 'Fuente de Glucosa',
      saveProfil: 'Guardar Perfil',
      dyslexiaFont: 'Fuente para Dislexia',
      dyslexiaHint: 'Usa la fuente OpenDyslexic para mejorar la legibilidad',
      enableDyslexic: 'Activar Fuente para Dislexia',
      diabetesType: 'Tipo de Diabetes',
      yourName: 'Tu Nombre',
      glucoseUnit: 'Unidad de Glucosa',
      weightUnit: 'Unidad de Peso',
      tempUnit: 'Unidad de Temperatura',
    },
    common: {
      save: 'Guardar',
      cancel: 'Cancelar',
      enable: 'Activar',
      stable: 'Estable',
      noData: 'Sin Datos',
    },
    footer: {
      madeBy: 'Hecho por Ken Wolf con \u{1F49A}',
      company: 'Med Inc',
    },
  },
  fr: {
    nav: { dashboard: 'Tableau de bord', agents: 'Agents', trackers: 'Suivis', devices: 'Appareils', settings: 'Param\u00e8tres' },
    dashboard: { title: 'Tableau de bord', notSynced: 'Non synchronis\u00e9', noData: 'Aucune donn\u00e9e', collectingReadings: 'Collecte des lectures', recentReadings: 'Lectures r\u00e9centes', noCgm: 'Pas de CGM connect\u00e9', enableAlerts: 'Activer les alertes', hourTrend: 'Tendance horaire' },
    settings: { title: 'Param\u00e8tres', cgm: 'CGM', ai: 'IA', fitness: 'Sport', alerts: 'Alertes', profile: 'Profil', glucoseSource: 'Source de glucose', saveProfil: 'Enregistrer le profil', dyslexiaFont: 'Police dyslexie', dyslexiaHint: 'Utilise OpenDyslexic pour une meilleure lisibilit\u00e9', enableDyslexic: 'Activer la police dyslexie', diabetesType: 'Type de diab\u00e8te', yourName: 'Votre nom', glucoseUnit: 'Unit\u00e9 de glucose', weightUnit: 'Unit\u00e9 de poids', tempUnit: 'Unit\u00e9 de temp\u00e9rature' },
    common: { save: 'Enregistrer', cancel: 'Annuler', enable: 'Activer', stable: 'Stable', noData: 'Aucune donn\u00e9e' },
    footer: { madeBy: 'Fait par Ken Wolf avec \u{1F49A}', company: 'Med Inc' },
  },
  pt: {
    nav: { dashboard: 'Painel', agents: 'Agentes', trackers: 'Rastreadores', devices: 'Dispositivos', settings: 'Configura\u00e7\u00f5es' },
    dashboard: { title: 'Painel', notSynced: 'N\u00e3o sincronizado', noData: 'Sem dados', collectingReadings: 'Coletando leituras', recentReadings: 'Leituras recentes', noCgm: 'Sem CGM conectado', enableAlerts: 'Ativar alertas', hourTrend: 'Tend\u00eancia por hora' },
    settings: { title: 'Configura\u00e7\u00f5es', cgm: 'CGM', ai: 'IA', fitness: 'Fitness', alerts: 'Alertas', profile: 'Perfil', glucoseSource: 'Fonte de glicose', saveProfil: 'Salvar perfil', dyslexiaFont: 'Fonte para dislexia', dyslexiaHint: 'Usa OpenDyslexic para melhor leitura', enableDyslexic: 'Ativar fonte para dislexia', diabetesType: 'Tipo de diabetes', yourName: 'Seu nome', glucoseUnit: 'Unidade de glicose', weightUnit: 'Unidade de peso', tempUnit: 'Unidade de temperatura' },
    common: { save: 'Salvar', cancel: 'Cancelar', enable: 'Ativar', stable: 'Est\u00e1vel', noData: 'Sem dados' },
    footer: { madeBy: 'Feito por Ken Wolf com \u{1F49A}', company: 'Med Inc' },
  },
  de: {
    nav: { dashboard: '\u00dcbersicht', agents: 'Agenten', trackers: 'Tracker', devices: 'Ger\u00e4te', settings: 'Einstellungen' },
    dashboard: { title: '\u00dcbersicht', notSynced: 'Nicht synchronisiert', noData: 'Keine Daten', collectingReadings: 'Daten werden erfasst', recentReadings: 'Letzte Messungen', noCgm: 'Kein CGM verbunden', enableAlerts: 'Alarme aktivieren', hourTrend: 'Stundentrend' },
    settings: { title: 'Einstellungen', cgm: 'CGM', ai: 'KI', fitness: 'Fitness', alerts: 'Alarme', profile: 'Profil', glucoseSource: 'Glukose-Quelle', saveProfil: 'Profil speichern', dyslexiaFont: 'Legasthenie-Schrift', dyslexiaHint: 'Verwendet OpenDyslexic f\u00fcr bessere Lesbarkeit', enableDyslexic: 'Legasthenie-Schrift aktivieren', diabetesType: 'Diabetes-Typ', yourName: 'Ihr Name', glucoseUnit: 'Glukose-Einheit', weightUnit: 'Gewichtseinheit', tempUnit: 'Temperatureinheit' },
    common: { save: 'Speichern', cancel: 'Abbrechen', enable: 'Aktivieren', stable: 'Stabil', noData: 'Keine Daten' },
    footer: { madeBy: 'Erstellt von Ken Wolf mit \u{1F49A}', company: 'Med Inc' },
  },
  zh: {
    nav: { dashboard: '\u4eea\u8868\u76d8', agents: '\u667a\u80fd\u4f53', trackers: '\u8ddf\u8e2a\u5668', devices: '\u8bbe\u5907', settings: '\u8bbe\u7f6e' },
    dashboard: { title: '\u4eea\u8868\u76d8', notSynced: '\u672a\u540c\u6b65', noData: '\u65e0\u6570\u636e', collectingReadings: '\u6b63\u5728\u6536\u96c6\u8bfb\u6570', recentReadings: '\u6700\u8fd1\u8bfb\u6570', noCgm: '\u672a\u8fde\u63a5CGM', enableAlerts: '\u542f\u7528\u8b66\u62a5', hourTrend: '\u5c0f\u65f6\u8d8b\u52bf' },
    settings: { title: '\u8bbe\u7f6e', cgm: 'CGM', ai: 'AI', fitness: '\u5065\u8eab', alerts: '\u8b66\u62a5', profile: '\u4e2a\u4eba\u8d44\u6599', glucoseSource: '\u8840\u7cd6\u6765\u6e90', saveProfil: '\u4fdd\u5b58\u8d44\u6599', dyslexiaFont: '\u8bfb\u5199\u969c\u788d\u5b57\u4f53', dyslexiaHint: '\u4f7f\u7528OpenDyslexic\u5b57\u4f53\u63d0\u9ad8\u53ef\u8bfb\u6027', enableDyslexic: '\u542f\u7528\u8bfb\u5199\u969c\u788d\u5b57\u4f53', diabetesType: '\u7cd6\u5c3f\u75c5\u7c7b\u578b', yourName: '\u60a8\u7684\u540d\u5b57', glucoseUnit: '\u8840\u7cd6\u5355\u4f4d', weightUnit: '\u4f53\u91cd\u5355\u4f4d', tempUnit: '\u6e29\u5ea6\u5355\u4f4d' },
    common: { save: '\u4fdd\u5b58', cancel: '\u53d6\u6d88', enable: '\u542f\u7528', stable: '\u7a33\u5b9a', noData: '\u65e0\u6570\u636e' },
    footer: { madeBy: 'Ken Wolf \u7528 \u{1F49A} \u5236\u4f5c', company: 'Med Inc' },
  },
  hi: {
    nav: { dashboard: '\u0921\u0948\u0936\u092c\u094b\u0930\u094d\u0921', agents: '\u090f\u091c\u0947\u0902\u091f', trackers: '\u091f\u094d\u0930\u0948\u0915\u0930', devices: '\u0921\u093f\u0935\u093e\u0907\u0938', settings: '\u0938\u0947\u091f\u093f\u0902\u0917\u094d\u0938' },
    dashboard: { title: '\u0921\u0948\u0936\u092c\u094b\u0930\u094d\u0921', notSynced: '\u0938\u093f\u0902\u0915 \u0928\u0939\u0940\u0902', noData: '\u0915\u094b\u0908 \u0921\u0947\u091f\u093e \u0928\u0939\u0940\u0902', collectingReadings: '\u0930\u0940\u0921\u093f\u0902\u0917 \u090f\u0915\u0924\u094d\u0930 \u0915\u0930 \u0930\u0939\u0947 \u0939\u0948\u0902', recentReadings: '\u0939\u093e\u0932 \u0915\u0940 \u0930\u0940\u0921\u093f\u0902\u0917', noCgm: 'CGM \u0915\u0928\u0947\u0915\u094d\u091f \u0928\u0939\u0940\u0902', enableAlerts: '\u0905\u0932\u0930\u094d\u091f \u0938\u0915\u094d\u0930\u093f\u092f \u0915\u0930\u0947\u0902', hourTrend: '\u0918\u0902\u091f\u0947 \u0915\u093e \u0930\u0941\u091d\u093e\u0928' },
    settings: { title: '\u0938\u0947\u091f\u093f\u0902\u0917\u094d\u0938', cgm: 'CGM', ai: 'AI', fitness: '\u092b\u093f\u091f\u0928\u0947\u0938', alerts: '\u0905\u0932\u0930\u094d\u091f', profile: '\u092a\u094d\u0930\u094b\u092b\u093e\u0907\u0932', glucoseSource: '\u0917\u094d\u0932\u0942\u0915\u094b\u091c \u0938\u094d\u0930\u094b\u0924', saveProfil: '\u092a\u094d\u0930\u094b\u092b\u093e\u0907\u0932 \u0938\u0939\u0947\u091c\u0947\u0902', dyslexiaFont: '\u0921\u093f\u0938\u094d\u0932\u0947\u0915\u094d\u0938\u093f\u092f\u093e \u092b\u0949\u0928\u094d\u091f', dyslexiaHint: '\u092c\u0947\u0939\u0924\u0930 \u092a\u0920\u0928\u0940\u092f\u0924\u093e \u0915\u0947 \u0932\u093f\u090f OpenDyslexic', enableDyslexic: '\u0921\u093f\u0938\u094d\u0932\u0947\u0915\u094d\u0938\u093f\u092f\u093e \u092b\u0949\u0928\u094d\u091f \u0938\u0915\u094d\u0930\u093f\u092f \u0915\u0930\u0947\u0902', diabetesType: '\u092e\u0927\u0941\u092e\u0947\u0939 \u092a\u094d\u0930\u0915\u093e\u0930', yourName: '\u0906\u092a\u0915\u093e \u0928\u093e\u092e', glucoseUnit: '\u0917\u094d\u0932\u0942\u0915\u094b\u091c \u0907\u0915\u093e\u0908', weightUnit: '\u0935\u091c\u0928 \u0907\u0915\u093e\u0908', tempUnit: '\u0924\u093e\u092a\u092e\u093e\u0928 \u0907\u0915\u093e\u0908' },
    common: { save: '\u0938\u0939\u0947\u091c\u0947\u0902', cancel: '\u0930\u0926\u094d\u0926 \u0915\u0930\u0947\u0902', enable: '\u0938\u0915\u094d\u0930\u093f\u092f', stable: '\u0938\u094d\u0925\u093f\u0930', noData: '\u0915\u094b\u0908 \u0921\u0947\u091f\u093e \u0928\u0939\u0940\u0902' },
    footer: { madeBy: 'Ken Wolf \u0928\u0947 \u{1F49A} \u0938\u0947 \u092c\u0928\u093e\u092f\u093e', company: 'Med Inc' },
  },
  ar: {
    nav: { dashboard: '\u0644\u0648\u062d\u0629 \u0627\u0644\u062a\u062d\u0643\u0645', agents: '\u0627\u0644\u0648\u0643\u0644\u0627\u0621', trackers: '\u0627\u0644\u0645\u062a\u0627\u0628\u0639\u0629', devices: '\u0627\u0644\u0623\u062c\u0647\u0632\u0629', settings: '\u0627\u0644\u0625\u0639\u062f\u0627\u062f\u0627\u062a' },
    dashboard: { title: '\u0644\u0648\u062d\u0629 \u0627\u0644\u062a\u062d\u0643\u0645', notSynced: '\u063a\u064a\u0631 \u0645\u062a\u0632\u0627\u0645\u0646', noData: '\u0644\u0627 \u062a\u0648\u062c\u062f \u0628\u064a\u0627\u0646\u0627\u062a', collectingReadings: '\u062c\u0645\u0639 \u0627\u0644\u0642\u0631\u0627\u0621\u0627\u062a', recentReadings: '\u0627\u0644\u0642\u0631\u0627\u0621\u0627\u062a \u0627\u0644\u0623\u062e\u064a\u0631\u0629', noCgm: '\u0644\u0627 \u064a\u0648\u062c\u062f CGM \u0645\u062a\u0635\u0644', enableAlerts: '\u062a\u0641\u0639\u064a\u0644 \u0627\u0644\u062a\u0646\u0628\u064a\u0647\u0627\u062a', hourTrend: '\u0627\u0644\u0627\u062a\u062c\u0627\u0647 \u0627\u0644\u0633\u0627\u0639\u064a' },
    settings: { title: '\u0627\u0644\u0625\u0639\u062f\u0627\u062f\u0627\u062a', cgm: 'CGM', ai: '\u0630\u0643\u0627\u0621 \u0627\u0635\u0637\u0646\u0627\u0639\u064a', fitness: '\u0644\u064a\u0627\u0642\u0629', alerts: '\u062a\u0646\u0628\u064a\u0647\u0627\u062a', profile: '\u0627\u0644\u0645\u0644\u0641 \u0627\u0644\u0634\u062e\u0635\u064a', glucoseSource: '\u0645\u0635\u062f\u0631 \u0627\u0644\u062c\u0644\u0648\u0643\u0648\u0632', saveProfil: '\u062d\u0641\u0638 \u0627\u0644\u0645\u0644\u0641', dyslexiaFont: '\u062e\u0637 \u0639\u0633\u0631 \u0627\u0644\u0642\u0631\u0627\u0621\u0629', dyslexiaHint: '\u064a\u0633\u062a\u062e\u062f\u0645 OpenDyslexic \u0644\u0642\u0631\u0627\u0621\u0629 \u0623\u0641\u0636\u0644', enableDyslexic: '\u062a\u0641\u0639\u064a\u0644 \u062e\u0637 \u0639\u0633\u0631 \u0627\u0644\u0642\u0631\u0627\u0621\u0629', diabetesType: '\u0646\u0648\u0639 \u0627\u0644\u0633\u0643\u0631\u064a', yourName: '\u0627\u0633\u0645\u0643', glucoseUnit: '\u0648\u062d\u062f\u0629 \u0627\u0644\u062c\u0644\u0648\u0643\u0648\u0632', weightUnit: '\u0648\u062d\u062f\u0629 \u0627\u0644\u0648\u0632\u0646', tempUnit: '\u0648\u062d\u062f\u0629 \u0627\u0644\u062d\u0631\u0627\u0631\u0629' },
    common: { save: '\u062d\u0641\u0638', cancel: '\u0625\u0644\u063a\u0627\u0621', enable: '\u062a\u0641\u0639\u064a\u0644', stable: '\u0645\u0633\u062a\u0642\u0631', noData: '\u0644\u0627 \u062a\u0648\u062c\u062f \u0628\u064a\u0627\u0646\u0627\u062a' },
    footer: { madeBy: '\u0635\u0646\u0639\u0647 Ken Wolf \u0628\u0640 \u{1F49A}', company: 'Med Inc' },
  },
  ja: {
    nav: { dashboard: '\u30c0\u30c3\u30b7\u30e5\u30dc\u30fc\u30c9', agents: '\u30a8\u30fc\u30b8\u30a7\u30f3\u30c8', trackers: '\u30c8\u30e9\u30c3\u30ab\u30fc', devices: '\u30c7\u30d0\u30a4\u30b9', settings: '\u8a2d\u5b9a' },
    dashboard: { title: '\u30c0\u30c3\u30b7\u30e5\u30dc\u30fc\u30c9', notSynced: '\u672a\u540c\u671f', noData: '\u30c7\u30fc\u30bf\u306a\u3057', collectingReadings: '\u8a08\u6e2c\u4e2d', recentReadings: '\u6700\u8fd1\u306e\u8a08\u6e2c', noCgm: 'CGM\u672a\u63a5\u7d9a', enableAlerts: '\u30a2\u30e9\u30fc\u30c8\u3092\u6709\u52b9\u306b', hourTrend: '\u6642\u9593\u30c8\u30ec\u30f3\u30c9' },
    settings: { title: '\u8a2d\u5b9a', cgm: 'CGM', ai: 'AI', fitness: '\u30d5\u30a3\u30c3\u30c8\u30cd\u30b9', alerts: '\u30a2\u30e9\u30fc\u30c8', profile: '\u30d7\u30ed\u30d5\u30a3\u30fc\u30eb', glucoseSource: '\u8840\u7cd6\u30bd\u30fc\u30b9', saveProfil: '\u30d7\u30ed\u30d5\u30a3\u30fc\u30eb\u3092\u4fdd\u5b58', dyslexiaFont: '\u30c7\u30a3\u30b9\u30ec\u30af\u30b7\u30a2\u30d5\u30a9\u30f3\u30c8', dyslexiaHint: '\u8aad\u307f\u3084\u3059\u3055\u306e\u305f\u3081\u306bOpenDyslexic\u3092\u4f7f\u7528', enableDyslexic: '\u30c7\u30a3\u30b9\u30ec\u30af\u30b7\u30a2\u30d5\u30a9\u30f3\u30c8\u3092\u6709\u52b9\u306b', diabetesType: '\u7cd6\u5c3f\u75c5\u30bf\u30a4\u30d7', yourName: '\u304a\u540d\u524d', glucoseUnit: '\u8840\u7cd6\u5358\u4f4d', weightUnit: '\u4f53\u91cd\u5358\u4f4d', tempUnit: '\u6e29\u5ea6\u5358\u4f4d' },
    common: { save: '\u4fdd\u5b58', cancel: '\u30ad\u30e3\u30f3\u30bb\u30eb', enable: '\u6709\u52b9', stable: '\u5b89\u5b9a', noData: '\u30c7\u30fc\u30bf\u306a\u3057' },
    footer: { madeBy: 'Ken Wolf \u304c \u{1F49A} \u3067\u4f5c\u6210', company: 'Med Inc' },
  },
};

function getNestedValue(obj, path) {
  return path.split('.').reduce((cur, key) => (cur && cur[key] !== undefined ? cur[key] : undefined), obj);
}

function getSavedLocale() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && translations[saved]) return saved;
  } catch {}
  return 'en';
}

const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [locale, setLocaleState] = useState(getSavedLocale);

  const setLocale = useCallback((code) => {
    if (translations[code]) {
      setLocaleState(code);
      try {
        localStorage.setItem(STORAGE_KEY, code);
      } catch {}
    }
  }, []);

  const t = useCallback(
    (key) => {
      const value = getNestedValue(translations[locale], key);
      return value !== undefined ? value : key;
    },
    [locale],
  );

  const value = useMemo(
    () => ({ t, locale, setLocale, locales }),
    [t, locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation() {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useTranslation must be used within an I18nProvider');
  }
  return ctx;
}

export { locales, translations };
