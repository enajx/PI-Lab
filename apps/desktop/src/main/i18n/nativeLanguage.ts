import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type NativeLanguage = "en" | "zh-CN" | "ko" | "ja" | "es" | "ar" | "nb"

const codes: readonly NativeLanguage[] = ["en", "zh-CN", "ko", "ja", "es", "ar", "nb"]
const preferenceFile = "interface-language"
let currentLanguage: NativeLanguage = "en"

/** Accept only an interface language the app can display. */
export function setNativeLanguage(value: unknown): value is NativeLanguage {
  if (!codes.includes(value as NativeLanguage)) return false
  currentLanguage = value as NativeLanguage
  return true
}

/** Read the current language for native UI created in the main process. */
export function getNativeLanguage(): NativeLanguage {
  return currentLanguage
}

/** Restore a saved choice before the scheduler, menu, and notifications start. */
export function loadNativeLanguage(dataDir: string): void {
  const path = join(dataDir, preferenceFile)
  if (existsSync(path)) setNativeLanguage(readFileSync(path, "utf8").trim())
}

/** Save a renderer choice for the next process start. */
export function saveNativeLanguage(dataDir: string, value: unknown): boolean {
  if (!setNativeLanguage(value)) return false
  writeFileSync(join(dataDir, preferenceFile), currentLanguage, "utf8")
  return true
}

const translations = {
  "PI Lab database could not be opened": [
    "无法打开 PI Lab 数据库",
    "PI Lab 데이터베이스를 열 수 없습니다",
    "PI Lab データベースを開けませんでした",
    "No se pudo abrir la base de datos de PI Lab",
    "تعذر فتح قاعدة بيانات PI Lab",
    "Kunne ikke åpne PI Lab-databasen",
  ],
  File: ["文件", "파일", "ファイル", "Archivo", "ملف", "Fil"],
  Edit: ["编辑", "편집", "編集", "Editar", "تحرير", "Rediger"],
  View: ["视图", "보기", "表示", "Ver", "عرض", "Vis"],
  Window: ["窗口", "윈도우", "ウィンドウ", "Ventana", "نافذة", "Vindu"],
  "About PI Lab": [
    "关于 PI Lab",
    "PI Lab 정보",
    "PI Lab について",
    "Acerca de PI Lab",
    "حول PI Lab",
    "Om PI Lab",
  ],
  "Hide PI Lab": [
    "隐藏 PI Lab",
    "PI Lab 가리기",
    "PI Lab を隠す",
    "Ocultar PI Lab",
    "إخفاء PI Lab",
    "Skjul PI Lab",
  ],
  "Hide Others": [
    "隐藏其他",
    "다른 앱 가리기",
    "ほかを隠す",
    "Ocultar los demás",
    "إخفاء الآخرين",
    "Skjul andre",
  ],
  "Show All": ["显示全部", "모두 보기", "すべてを表示", "Mostrar todo", "إظهار الكل", "Vis alle"],
  "Quit PI Lab": [
    "退出 PI Lab",
    "PI Lab 종료",
    "PI Lab を終了",
    "Salir de PI Lab",
    "إنهاء PI Lab",
    "Avslutt PI Lab",
  ],
  Undo: ["撤销", "실행 취소", "取り消す", "Deshacer", "تراجع", "Angre"],
  Redo: ["重做", "다시 실행", "やり直す", "Rehacer", "إعادة", "Gjør om"],
  Cut: ["剪切", "잘라내기", "切り取り", "Cortar", "قص", "Klipp ut"],
  Copy: ["复制", "복사", "コピー", "Copiar", "نسخ", "Kopier"],
  Paste: ["粘贴", "붙여넣기", "貼り付け", "Pegar", "لصق", "Lim inn"],
  "Paste and Match Style": [
    "粘贴并匹配样式",
    "스타일에 맞춰 붙여넣기",
    "スタイルを合わせて貼り付け",
    "Pegar con el mismo estilo",
    "لصق ومطابقة النمط",
    "Lim inn og tilpass stil",
  ],
  Delete: ["删除", "삭제", "削除", "Eliminar", "حذف", "Slett"],
  "Select All": ["全选", "모두 선택", "すべてを選択", "Seleccionar todo", "تحديد الكل", "Merk alt"],
  Reload: ["重新加载", "새로고침", "再読み込み", "Recargar", "إعادة تحميل", "Last inn på nytt"],
  "Force Reload": [
    "强制重新加载",
    "강력 새로고침",
    "強制再読み込み",
    "Forzar recarga",
    "فرض إعادة التحميل",
    "Tving ny innlasting",
  ],
  "Toggle Developer Tools": [
    "切换开发者工具",
    "개발자 도구 전환",
    "開発者ツールを切り替え",
    "Alternar herramientas de desarrollo",
    "تبديل أدوات المطور",
    "Vis eller skjul utviklerverktøy",
  ],
  "Actual Size": [
    "实际大小",
    "실제 크기",
    "実際のサイズ",
    "Tamaño real",
    "الحجم الفعلي",
    "Faktisk størrelse",
  ],
  "Zoom In": ["放大", "확대", "拡大", "Ampliar", "تكبير", "Zoom inn"],
  "Zoom Out": ["缩小", "축소", "縮小", "Reducir", "تصغير", "Zoom ut"],
  "Toggle Full Screen": [
    "切换全屏",
    "전체 화면 전환",
    "フルスクリーンを切り替え",
    "Alternar pantalla completa",
    "تبديل ملء الشاشة",
    "Slå fullskjerm av eller på",
  ],
  Minimize: ["最小化", "최소화", "最小化", "Minimizar", "تصغير النافذة", "Minimer"],
  Zoom: ["缩放", "확대/축소", "ズーム", "Zoom", "تكبير النافذة", "Zoom"],
  "Bring All to Front": [
    "全部置于最前",
    "모두 앞으로 가져오기",
    "すべてを手前に移動",
    "Traer todo al frente",
    "إحضار الكل إلى المقدمة",
    "Flytt alle fremst",
  ],
  "Workflow started": [
    "工作流已启动",
    "워크플로가 시작됨",
    "ワークフローを開始しました",
    "Flujo de trabajo iniciado",
    "بدأ سير العمل",
    "Arbeidsflyt startet",
  ],
  "Workflow completed": [
    "工作流已完成",
    "워크플로가 완료됨",
    "ワークフローが完了しました",
    "Flujo de trabajo completado",
    "اكتمل سير العمل",
    "Arbeidsflyt fullført",
  ],
  "Workflow failed": [
    "工作流失败",
    "워크플로가 실패함",
    "ワークフローが失敗しました",
    "Error en el flujo de trabajo",
    "فشل سير العمل",
    "Arbeidsflyt mislyktes",
  ],
  "Terminal command finished": [
    "终端命令已完成",
    "터미널 명령이 완료됨",
    "ターミナルのコマンドが完了しました",
    "Comando de terminal terminado",
    "انتهى أمر الطرفية",
    "Terminalkommando fullført",
  ],
  "Agent needs input": [
    "智能体需要输入",
    "에이전트에 입력이 필요함",
    "エージェントへの入力が必要です",
    "El agente necesita una respuesta",
    "الوكيل يحتاج إلى إدخال",
    "Agenten trenger svar",
  ],
  "Agent finished its turn": [
    "智能体已完成本轮",
    "에이전트가 차례를 마침",
    "エージェントの応答が完了しました",
    "El agente terminó su turno",
    "أكمل الوكيل دوره",
    "Agenten er ferdig med sin tur",
  ],
  permission: ["权限", "권한", "許可", "permiso", "إذن", "tillatelse"],
  "an answer": ["回答", "답변", "回答", "una respuesta", "إجابة", "et svar"],
  "your next instruction": [
    "您的下一条指令",
    "다음 지시",
    "次の指示",
    "tu siguiente instrucción",
    "تعليماتك التالية",
    "din neste instruksjon",
  ],
  "non-interactive": [
    "非交互",
    "비대화형",
    "非対話",
    "no interactivo",
    "غير التفاعلي",
    "ikke-interaktiv",
  ],
  chat: ["聊天", "채팅", "チャット", "chat", "الدردشة", "chat"],
} as const

export type NativeText = keyof typeof translations
const translatedCodes = ["zh-CN", "ko", "ja", "es", "ar", "nb"] as const

/** Translate an app-owned menu label or notification phrase. */
export function nativeText(english: NativeText): string {
  if (currentLanguage === "en") return english
  const index = translatedCodes.indexOf(currentLanguage)
  return translations[english][index] ?? english
}

/** Format app-owned notification bodies while preserving user-provided names. */
export function nativeNotificationBody(
  kind: "terminalReady" | "agentWaiting" | "agentReady" | "workflowStarted" | "workflowCompleted",
  name: string,
  detail?: NativeText,
): string {
  switch (currentLanguage) {
    case "zh-CN":
      if (kind === "terminalReady") return `${name} 已准备好接收下一条命令`
      if (kind === "agentWaiting")
        return `${name} 正在等待${nativeText(detail ?? "your next instruction")}`
      if (kind === "agentReady") return `${name} 已准备好接收您的下一条指令`
      if (kind === "workflowStarted")
        return `${name} 已在${nativeText(detail ?? "non-interactive")}模式下启动`
      return `${name} 已完成`
    case "ko":
      if (kind === "terminalReady") return `${name}에서 다음 명령을 입력할 수 있습니다`
      if (kind === "agentWaiting")
        return `${name}이(가) ${nativeText(detail ?? "your next instruction")}을(를) 기다리고 있습니다`
      if (kind === "agentReady") return `${name}이(가) 다음 지시를 받을 준비가 되었습니다`
      if (kind === "workflowStarted")
        return `${name}이(가) ${nativeText(detail ?? "non-interactive")} 모드로 시작되었습니다`
      return `${name}이(가) 완료되었습니다`
    case "ja":
      if (kind === "terminalReady") return `${name} は次のコマンドを受け付けられます`
      if (kind === "agentWaiting")
        return `${name} は${nativeText(detail ?? "your next instruction")}を待っています`
      if (kind === "agentReady") return `${name} は次の指示を受け付けられます`
      if (kind === "workflowStarted")
        return `${name} を${nativeText(detail ?? "non-interactive")}モードで開始しました`
      return `${name} が完了しました`
    case "es":
      if (kind === "terminalReady") return `${name} está listo para el siguiente comando`
      if (kind === "agentWaiting")
        return `${name} espera ${nativeText(detail ?? "your next instruction")}`
      if (kind === "agentReady") return `${name} está listo para tu siguiente instrucción`
      if (kind === "workflowStarted")
        return `${name} comenzó en modo ${nativeText(detail ?? "non-interactive")}`
      return `${name} se completó`
    case "ar":
      if (kind === "terminalReady") return `${name} جاهز للأمر التالي`
      if (kind === "agentWaiting")
        return `${name} ينتظر ${nativeText(detail ?? "your next instruction")}`
      if (kind === "agentReady") return `${name} جاهز لتعليماتك التالية`
      if (kind === "workflowStarted")
        return `بدأ ${name} في وضع ${nativeText(detail ?? "non-interactive")}`
      return `اكتمل ${name}`
    case "nb":
      if (kind === "terminalReady") return `${name} er klar for neste kommando`
      if (kind === "agentWaiting")
        return `${name} venter på ${nativeText(detail ?? "your next instruction")}`
      if (kind === "agentReady") return `${name} er klar for din neste instruksjon`
      if (kind === "workflowStarted")
        return `${name} startet i ${nativeText(detail ?? "non-interactive")} modus`
      return `${name} er fullført`
    case "en":
      if (kind === "terminalReady") return `${name} is ready for the next command`
      if (kind === "agentWaiting")
        return `${name} is waiting for ${detail ?? "your next instruction"}`
      if (kind === "agentReady") return `${name} is ready for your next instruction`
      if (kind === "workflowStarted")
        return `${name} started in ${detail ?? "non-interactive"} mode`
      return `${name} completed`
  }
}
