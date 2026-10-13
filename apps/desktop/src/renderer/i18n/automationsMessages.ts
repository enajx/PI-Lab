import type { InterfaceLanguage } from "./language"

type Row = readonly [string, string, string, string, string, string, string]
const rows: Row[] = [
  [
    "Workflows",
    "工作流程",
    "워크플로",
    "ワークフロー",
    "Flujos de trabajo",
    "سير العمل",
    "Arbeidsflyter",
  ],
  [
    "Scheduled & looping agent runs",
    "计划和循环运行的代理",
    "예약 및 반복 에이전트 실행",
    "定期実行と繰り返しのエージェント実行",
    "Ejecuciones programadas y repetidas de agentes",
    "تشغيلات الوكلاء المجدولة والمتكررة",
    "Planlagte og gjentatte agentkjøringer",
  ],
  [
    "Open a project first",
    "请先打开一个项目",
    "먼저 프로젝트를 여세요",
    "先にプロジェクトを開いてください",
    "Abre primero un proyecto",
    "افتح مشروعًا أولاً",
    "Åpne et prosjekt først",
  ],
  [
    "Create a recurring agent run for a project, prompt, and schedule",
    "为项目、提示词和时间表创建重复的代理任务",
    "프로젝트, 프롬프트 및 일정에 대한 반복 에이전트 작업을 만듭니다",
    "プロジェクト、プロンプト、予定に対する定期的なエージェント実行を作成",
    "Crea una ejecución recurrente de un agente para un proyecto, una instrucción y un horario",
    "أنشئ تشغيلًا متكررًا للوكيل وفق مشروع وتوجيه وجدول",
    "Opprett en gjentatt agentkjøring for et prosjekt, en instruksjon og en tidsplan",
  ],
  [
    "New workflow",
    "新建工作流程",
    "새 워크플로",
    "新しいワークフロー",
    "Nuevo flujo de trabajo",
    "سير عمل جديد",
    "Ny arbeidsflyt",
  ],
  [
    "Find a workflow",
    "查找工作流程",
    "워크플로 찾기",
    "ワークフローを探す",
    "Buscar un flujo de trabajo",
    "ابحث عن سير عمل",
    "Finn en arbeidsflyt",
  ],
  [
    "Find a workflow…",
    "查找工作流程…",
    "워크플로 찾기…",
    "ワークフローを探す…",
    "Buscar un flujo de trabajo…",
    "ابحث عن سير عمل…",
    "Finn en arbeidsflyt…",
  ],
  [
    "No matching workflows",
    "没有匹配的工作流程",
    "일치하는 워크플로 없음",
    "一致するワークフローはありません",
    "No hay flujos de trabajo coincidentes",
    "لا توجد مهام سير عمل مطابقة",
    "Ingen samsvarende arbeidsflyter",
  ],
  [
    "No workflows yet",
    "暂无工作流程",
    "아직 워크플로가 없습니다",
    "ワークフローはまだありません",
    "Todavía no hay flujos de trabajo",
    "لا توجد مهام سير عمل بعد",
    "Ingen arbeidsflyter ennå",
  ],
  [
    "Workflows run an agent on a project on a schedule — nightly checks, recurring sweeps, or a looping research task.",
    "工作流程按计划在项目中运行代理，可用于夜间检查、定期扫描或循环研究任务。",
    "워크플로는 일정에 따라 프로젝트에서 에이전트를 실행하며 야간 점검, 정기 검사 또는 반복 연구 작업에 사용할 수 있습니다.",
    "ワークフローは予定に従ってプロジェクトのエージェントを実行します。夜間の確認、定期的な調査、繰り返す研究作業に使えます。",
    "Los flujos de trabajo ejecutan un agente en un proyecto según un horario: comprobaciones nocturnas, búsquedas periódicas o tareas de investigación repetidas.",
    "يشغّل سير العمل وكيلاً في مشروع وفق جدول، للفحوص الليلية أو المسوحات الدورية أو مهام البحث المتكررة.",
    "Arbeidsflyter kjører en agent i et prosjekt etter en tidsplan, for nattlige kontroller, gjentatte søk eller forskningsarbeid som gjentas.",
  ],
  [
    "Open a project to create one.",
    "打开一个项目以创建工作流程。",
    "워크플로를 만들려면 프로젝트를 여세요.",
    "作成するにはプロジェクトを開いてください。",
    "Abre un proyecto para crear uno.",
    "افتح مشروعًا لإنشاء واحد.",
    "Åpne et prosjekt for å opprette en.",
  ],
]

const localeOrder = ["zh-CN", "ko", "ja", "es", "ar", "nb"] as const

/** Workflow view translations, excluding user-supplied names and schedule data. */
export const automationsMessages = Object.fromEntries(
  localeOrder.map((locale, index) => [
    locale,
    Object.fromEntries(rows.map((row) => [row[0], row[index + 1]])),
  ]),
) as Record<Exclude<InterfaceLanguage, "en">, Record<string, string>>
