/**
 * 도면관리 시스템(TDMS) 구축 Kick-off — 발표자 가이드 (docx)
 * TDMS_Project_Kickoff_20261124.pptx (20장) 과 1:1.
 */
const fs = require('fs')
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle,
  Table, TableRow, TableCell, WidthType, ShadingType, LevelFormat, PageBreak,
} = require('docx')

const OUT = '/home/quri/ghub-tdms/docs/발표자료/TDMS_Kickoff_발표자가이드_20261124.docx'
const FONT = '맑은 고딕'
const NAVY = '12304B', BLUE = '2A6FA8', GREY = '55606B', MUTED = '7A848F'

/* ── 장별 내용 — tdms_project_kickoff_20slides.pptx (본 발표자료) 와 1:1 ── */
const SLIDES = [
  {
    t: '프로젝트 Kick-off (표지)',
    key: '오늘 회의는 소개 자리가 아니라 범위 · 일정 · 역할 · 검수 기준을 맞추는 자리입니다.',
    lines: [
      '프로젝트명: 도면관리 시스템(TDMS) 구축 — 도면(TDB) · 설비 데이터북(MDB)',
      '고객사 지허브  ·  수행사 진네트웍스',
      '수행 기간: 2026. 11. 17. ~ 2027. 01. 15. (9주)',
      'Kick-off: 2026. 11. 24. (화) 11:00~11:40 · 정비동 회의실',
      '기술: Vue 3 · Fastify(Node 22) · PostgreSQL 16 · Python 워커 · Docker',
    ],
    talk: '표지에서 수행 기간과 완료일을 먼저 못박습니다. "11월 17일 착수, 1월 15일 완료"를 입으로 한 번 말해 두면 뒤의 일정 장에서 설명이 짧아집니다. 오른쪽 9 WEEKS 블록의 세 덩어리(분석·설계 / 구현·이행 / 검증·전환)를 한 문장씩 소개하고 바로 다음 장으로 넘어갑니다.',
  },
  {
    t: 'Kick-off에서 합의할 사항',
    key: '오늘의 목표는 범위 · 일정 · 역할 · 검수 기준을 하나의 기준으로 합의하는 것입니다.',
    lines: [
      '프로젝트 목표와 완료(인수) 기준',
      '개발 범위와 제외 범위, 우선순위',
      '9주 일정(2026.11.17 ~ 2027.01.15)과 승인 시점',
      '기술 구성 · 데이터 이행 · 전환 원칙',
      '양사 역할과 보고 · 이슈 처리 방식, 사전 준비분 활용 범위',
    ],
    talk: '다섯 가지를 먼저 제시해 회의의 지도를 그립니다. "오늘 결론이 나지 않는 것은 담당자와 기한을 정해 회의록에 남기겠습니다"라고 미리 선언해 두면 논쟁이 길어질 때 끊기 쉽습니다. 마지막 항목(사전 준비분)은 8번 장에서 다룬다고 예고합니다.',
  },
  {
    t: '추진 배경 및 현황',
    key: '현행 시스템은 기능이 모자란 것이 아니라 구조가 업무를 따라가지 못합니다.',
    lines: [
      '대상: 도면 10,827건 · 파일 16,400개 / 6.5GB · MDB 자료 1,200건',
      '성격: 기존 API 201개 중 순수 조회 12%, 파일 상태 전이 · 워크플로 88%',
      '구조 제약: 폴더가 문자열 · 파일명이 메타데이터 · 장시간 작업이 동기 실행',
      '보안 점검 25건(높음 7 · 중간 13 · 낮음 5) · 운영은 Windows 단일 서버',
    ],
    talk: '수치는 전달받은 소스와 DB를 전수 분석한 결과이며 추측이 아니라는 점을 밝힙니다. "조회 12%" 한 숫자를 강조하면 뒤의 설계 판단(파일을 움직이지 않는 구조, 작업 큐)이 자연스럽게 따라옵니다. 현황에 사실과 다른 부분이 있으면 1~2주차 확인 단계에서 바로잡는다고 안내합니다.',
  },
  {
    t: '프로젝트 목표 및 성공 기준',
    key: '완료는 기능 구현이 아니라 동등성 증명 · 검수 승인 · 운영 인계까지입니다.',
    lines: [
      '업무: 기능 100% 보존 — 메뉴 9 · 화면 14 · 권한 36 · API 201 전수 재현',
      '사용자: 쓰시던 화면 구성과 용어를 유지해 재교육 부담을 없앤다',
      '기술: 폴더 트리 · 내용 해시 저장 · 작업 큐로 상태 전이 비용을 제거',
      '성능: 목록 150ms · 폴더 편집 50ms 이하를 자동 검사로 고정(52,000건 실측 기준)',
      '완료 기준: 기능 체크리스트 · sha256 전수 일치 · 성능 기준 · UAT 승인과 인계',
    ],
    talk: '성능 수치는 실측 기반이며 임의 목표가 아니라고 설명합니다. 마지막 줄의 네 가지를 읽고 "이 네 가지를 인수 조건으로 문서에 넣겠습니다"라고 동의를 구합니다. 범위 축소는 수행사가 아니라 고객사 결정 사항임을 분명히 합니다.',
  },
  {
    t: '개발 범위 및 경계',
    key: '포함과 제외를 함께 정의해 일정 · 비용 · 기대치의 불일치를 예방합니다.',
    lines: [
      '포함: TDB · MDB 전 업무 기능 · 운영 화면 · PDF 뷰어 · 마크업',
      '포함: 기존 DB · 파일 전량 이행(sha256 검증) · 섀도 비교 · 전환 · 인계',
      '제외: Ocean-H 연동 · 웹 DWG 열람 · 전문검색 · DRM · SSO · 자동 병합',
      '제외(별도 단계): AWS 이관 · 유출 방지 2 · 3차 — 오늘은 방향만 결정',
      '범위 변경은 요청 → 영향 분석 → 승인 → 기준선 갱신으로만 반영',
    ],
    talk: '제외 범위는 임의로 뺀 것이 아니라 기존 시스템의 범위를 그대로 승계한 것이라고 분명히 합니다. AWS 이관은 요건서의 과제이지만 9주 안에 넣으면 전환 위험이 커지므로 분리를 권고합니다. 여기서 이견이 나오면 결론을 내려 하지 말고 "20번 장 결정 사항으로 올리겠습니다"라고 넘깁니다. 데이터 이행의 상세 절차는 12번(일정)과 18번(리스크)에서 다시 다룹니다.',
  },
  {
    t: '주요 사용자 및 업무 기능',
    key: '사용자 역할과 실제 업무 흐름(반출 → 수정 → 반입 → 검수 → 승인)을 기준으로 기능을 확정합니다.',
    lines: [
      '사용자: 설비기술팀 CM 및 사내 수십 명 / 협력사는 접근 없음',
      '업무 흐름: 반출 → 수정 → 반입 → 검수 → 승인 (동시 수정은 분기 보관)',
      'TDB: 조회 · 상세 / 반입 · 검수 / 관리 · 보관함 / 반출이력 · 미입고',
      'MDB: 조회 · 상세 / 관리(설비유형 · 폴더) / Tag 이력 적용 · 되돌리기',
      '운영: 로그 · 사용자/그룹 · 권한(리프 36) · 백업 · 도움말 (+ 추가 4화면)',
    ],
    talk: '업무 흐름에서 "검수"가 리비전이 올라가는 지점이자 업무 규칙이 가장 많이 걸리는 자리라고 설명합니다. 도면은 자동 병합하지 않고 사람이 CAD로 합친 것만 정식 Rev가 된다는 승계 규칙도 여기서 한 번 말해 둡니다. 화면별로 확인해 줄 CM 지정을 요청합니다(결정 4번).',
  },
  {
    t: '요구사항 정의 및 변경 관리',
    key: '기존 시스템의 기능 인벤토리를 요구사항 기준선으로 삼고, 변경은 승인된 것만 반영합니다.',
    lines: [
      '기준선: 기능 인벤토리(메뉴 9 · 화면 14 · 권한 36 · API 201) · 화면 요소 목록',
      '확인: 2주차(11/27)까지 CM 검토로 요구사항 · 범위 기준선을 확정',
      '우선순위: 필수(기존 동등) / 개선(합의 시 반영) / 제외(별도 단계)',
      '변경: 요청 등록 → 영향 분석 → 승인 → 기준선 갱신 (구두 합의 불가)',
      '추적: 요구사항 ↔ 구현 ↔ 테스트 케이스를 연결해 누락을 기계적으로 확인',
    ],
    talk: '요구사항을 처음부터 다시 받는 프로젝트가 아니라는 점이 이 장의 핵심입니다. 기존 기능이 기준선이고 거기서 더하거나 빼는 것만 합의하면 되므로 2주차 승인이 가능합니다. 변경을 거절하겠다는 뜻이 아니라 영향도를 투명하게 보여주고 승인된 것만 일정에 반영한다는 원칙임을 강조합니다.',
  },
  {
    t: '사전 준비분 및 활용 범위',
    key: '착수 전 선행 구축으로 골격은 준비돼 있습니다. 9주는 확정 · 이행 · 검증에 씁니다.',
    lines: [
      '화면 14 + 추가 4 구현 완료(미완성 0) · 권한 리프 36 전수 동작',
      '업무 흐름 자동 검증 138건 통과 · DB 29테이블 · 인덱스 93 적용',
      '도면 52,000건(실데이터 5배) 적재 성능 측정 — 전 항목 목표치 이하',
      '자동 배포 · 롤백 체계 구성(검사 → 빌드 → 배포 → 상태 확인)',
      '※ 기준선 대조 전 상태 — 요구사항 확정 후 차이분을 구현에 반영',
    ],
    talk: '이 장의 구분이 가장 중요합니다. "이미 다 만들었다"로 들리면 검수와 일정에 대한 기대가 어긋납니다. 기존 소스와 전달 자료를 바탕으로 미리 준비해 둔 것이며 아직 고객사 기준선과 대조하지 않은 상태라고 분명히 말합니다. 그 대신 9주 동안 개발에 쫓기지 않고 이행과 검증에 시간을 쓸 수 있다는 것이 이점입니다. 요청이 있으면 그 자리에서 실제 화면을 띄워 보여 줍니다.',
  },
  {
    t: '목표 시스템 아키텍처',
    key: '프로세스 3종(API · 워커 · DB)과 nginx 파일 직송 구조로 장애 지점과 운영 부담을 줄입니다.',
    lines: [
      '브라우저(Vue 3) → nginx(TLS · IP 제한 · 업로드 제한) → API(Fastify)',
      '파일은 nginx가 직송 — 애플리케이션이 파일 바이트를 만지지 않는다',
      '저장소: 내용 해시(sha256) blob — 불변 · 중복 제거 · 디스크 작업 0',
      'PostgreSQL 16: 업무 데이터 · 세션 · 폴더 트리 · 한글 검색 · 작업 큐',
      '워커(Python 3.12): DWG · 오피스 변환 · Zip · 엑셀 · 백업 · 대량 반입',
    ],
    talk: 'Redis나 메시지 브로커 같은 미들웨어를 하나도 늘리지 않은 이유(장애 지점 최소화, 운영 인력 부담)를 설명합니다. 오래 걸리는 일은 DB 작업 큐에 쌓고 워커가 집어 가며 진행률이 화면에 실시간으로 흐른다는 점을 말하면 "엑셀 누르면 멈춘다"는 기존 불편과 바로 연결됩니다.',
    visual: '브라우저 → nginx → API → blob 구조와 PostgreSQL ↔ 워커 관계는 10번 장 도식으로 보완.',
  },
  {
    t: '기술 스택 및 적용 원칙',
    key: '기술 선택보다 일관된 구조 · 코딩 규칙 · 운영 가능성을 우선합니다.',
    lines: [
      '사용자 브라우저(Web / HTTPS) → Frontend(Vue 3 + Vite)',
      'Backend API(Fastify · TypeScript) → Database(PostgreSQL 16)',
      'Docker 컨테이너 + Python 워커(DWG · 오피스 변환 · Zip · 엑셀 · 백업) · 배포 · 롤백 자동화',
      '적용 원칙: 버전 고정 · 계약(타입) 1벌 공유 · 권한 · 감사 선언 강제 · 환경별 설정 분리 · 성능 기준 자동 검사',
    ],
    talk: '선택 기준은 "사내 단일 서버에서 10년을 버틸 것" 하나였다고 말합니다. Python 워커를 유지한 이유는 도면 변환 라이브러리(ODA · ezdxf · LibreOffice)에 대체재가 없기 때문입니다. 인수인계 문서에 "PDF.js 8,400줄 포크"로 적혀 있던 항목은 코드 확인 결과 사실이 아니며 그대로 이식 가능한 자산이라는 점을 알려 주면 위험 하나가 줄어듭니다.',
    visual: '4단 흐름 도식 + 하단 Docker 띠.',
  },
  {
    t: '데이터 및 API 설계 원칙',
    key: '계약(타입) 한 벌을 프런트 · 백엔드가 공유해 재작업과 불일치를 없앱니다.',
    lines: [
      '계약: 스키마 1벌이 입력 검증 · 응답 직렬화 · 화면 타입을 모두 만든다',
      'API: 경로 · 상태 코드 · 오류 형식 통일, 기존 201개 경로와 호환 유지',
      '데이터: 폴더는 테이블(ltree) · keyset 페이징 · 한글 검색은 trgm 색인',
      '보안: 라우트마다 권한 · 감사를 선언하고, 선언이 빠지면 서버가 기동하지 않는다',
      '변경: 마이그레이션은 번호순으로 앞으로만. 적용된 파일은 수정하지 않는다',
    ],
    talk: '기술 용어가 많은 장이므로 효과 중심으로 말합니다 — 폴더 이름 변경이 수십 초에서 1ms 미만으로, 리비전 승인 시 디스크 작업이 0으로, 중간에 실패해도 DB와 디스크가 어긋나지 않습니다. 기존 OpenAPI 스냅샷을 받을 수 있으면 대조 품질이 올라간다고 요청합니다.',
  },
  {
    t: '9주 추진 일정 및 마일스톤',
    key: '2026.11.17 착수 → 2027.01.15 완료(9주). 고객사 검토 · 승인이 제때 이뤄지는 것을 전제로 합니다.',
    lines: [
      '1단계 · 분석 (11/17 ~ 11/27): 현행 분석 · 요구사항 · 범위 기준선 확정',
      '2단계 · 설계 (11/23 ~ 12/04): 화면 · API · ERD 확정 · 운영 환경 결정',
      '3단계 · 구현 · 이행 (11/30 ~ 12/25): 차이분 구현 · 변환 워커 · 데이터 이행 리허설',
      '4단계 · 검증 · 전환 (12/21 ~ 01/15): 통합 · 섀도 비교 · UAT · 본 이행 · 인계',
      '마일스톤: 11/27 기준선 승인 → 12/04 설계 · 환경 확정 → 12/11 이행 리허설 → 12/18 기능 시연 → 12/25 UAT 진입 → 01/08 UAT 승인 → 01/15 인계',
    ],
    talk: '9주는 기준 계획이며 1~2주차에 기준선을 확정하지 못하면 전체가 같은 만큼 밀린다고 못박습니다. 3단계에 들어 있는 데이터 이행은 수령 → 변환(폴더 문자열을 트리로, 파일 sha256 재배치) → 전수 검증 → 리허설 2회 → 본 이행 순서로 진행하며, 검증 불일치가 1건이라도 있으면 전환을 보류한다고 설명합니다. 연말 휴무(12/28~01/01)는 섀도 비교 구간에 겹쳐 손실을 줄였습니다.',
    visual: '4단계 카드 + 마일스톤 띠.',
  },
  {
    t: '단계별 산출물 및 승인 게이트',
    key: '각 단계는 산출물 제출과 검토 · 승인을 거쳐 다음 단계로 넘어갑니다.',
    lines: [
      '분석 ~11/27: 인벤토리 대조표 · 범위 확정서',
      '설계 ~12/04: 화면 체크리스트 · API 계약 · ERD',
      '구현 · 이행 ~12/25: 차이분 구현 · 이행 스크립트 · 리허설 보고',
      '검증 · 전환 ~01/15: 동등성 대조 · UAT · 인수인계서',
      '승인 게이트: 요구사항 · 범위 기준선 → 설계 · 환경 확정 → 기능 시연 · 리허설 결과 → UAT 승인 → 최종 검수 · 운영 인계',
    ],
    talk: '산출물마다 작성자 · 검토자 · 승인자와 승인 기한을 지정하자고 제안합니다. 기한 내 회신이 없을 때의 처리 규칙(예: 영업일 3일 경과 시 이의 없음으로 간주)도 함께 정해 두면 뒤에서 다투지 않습니다. 승인 지연은 그대로 일정 지연으로 반영된다는 점을 한 번 더 말합니다.',
  },
  {
    t: '프로젝트 조직 및 R&R',
    key: '업무 결정권자와 기술 실행 책임자를 구분해 의사결정 지연을 줄입니다.',
    lines: [
      '고객사 Sponsor: 방향 · 범위 · 최종 승인',
      '고객사 업무 책임자 · CM: 요구사항 확인 · UAT 검수',
      '수행사 PM: 일정 · 범위 · 리스크 · 보고',
      '수행사 Tech Lead: 아키텍처 · 품질 기준',
      '수행사 개발 · DevOps: 차이분 구현 · 이행 · 배포 / 검증 담당: 동등성 대조 · 성능 · 결함',
      '의사결정: 범위 · 일정 영향은 고객사 Sponsor 승인, 기술 구현 방식은 수행사 Tech Lead 결정',
    ],
    talk: '실제 이름과 연락처를 넣어 조직도를 확정해 달라고 요청합니다. 특히 고객사 측 업무 의사결정자와 대체 담당자까지 지정돼야 9주 일정이 유지됩니다. 휴가 · 부재로 승인이 멈추는 것이 가장 흔한 지연 원인이라고 설명하면 수용되기 쉽습니다.',
  },
  {
    t: '개발 협업 및 형상관리',
    key: '작업 단위 · 코드 리뷰 · 자동 검사를 표준화해 통합 위험을 조기에 발견합니다.',
    lines: [
      '흐름: 이슈 등록 → 기능 단위 브랜치 → PR 코드 리뷰 → 자동 검사 → 승인된 변경만 자동 배포',
      '자동 검사 항목: 타입 · 테스트 · 번들 예산 · 성능 기준',
      '품질 게이트를 통과해야 병합 · 배포하고, 실패하면 직전 버전으로 자동 복귀',
      '비밀값은 저장소 밖에서 관리',
    ],
    talk: '이미 운영 중인 체계이므로 새로 만들 것은 많지 않다고 말합니다. 고객사 쪽에서 정해 주실 것은 이슈 접수 채널, 저장소 접근 권한 범위, 주간 보고 요일과 형식 세 가지입니다.',
  },
  {
    t: '테스트 및 품질 전략',
    key: '‘같다’를 말이 아니라 기계적 대조로 증명합니다. 품질은 마지막에 몰아서 확보하지 않습니다.',
    lines: [
      '단위 · 통합: 업무 규칙 · API · DB 자동 검증 138건',
      '동등성 ① ②: API 계약 스냅샷 · 화면 요소 체크리스트 대조',
      '동등성 ③: 섀도 비교 2주 — 신 · 구 응답 직접 비교(쓰기는 기존 시스템에서만)',
      'UAT: CM 시나리오 기반 검수 (01/04 ~ 01/08)',
      '결함은 심각도 · 재현 절차 · 담당자 · 목표 조치일로 관리 · 성능 기준은 배포 때마다 자동 검사',
    ],
    talk: '동등성 검증이 이 프로젝트의 핵심 품질 활동입니다. 섀도 비교는 조회만 양쪽에 보내므로 업무에 영향이 없다는 점을 분명히 해야 안심합니다. UAT 시나리오와 합격 기준은 12월 중순까지 함께 만들자고 제안합니다(결정 6번).',
  },
  {
    t: 'Docker 기반 배포 및 운영 전환',
    key: '배포는 자동으로, 전환은 되돌릴 수 있게 준비합니다.',
    lines: [
      '흐름: Build(이미지 빌드) → Migrate(DB 마이그레이션) → Deploy(무중단 교체) → Verify(상태 · 헬스체크) → Rollback(실패 시 자동 복귀)',
      '백업 2중: DB(스냅샷 · 시점 복구)와 파일(blob)을 각각 보관하고 복구 리허설 수행',
      '전환: 병행 운영 → 전환 → 1~2주 밀착 대응. 기존 시스템으로 즉시 되돌릴 수 있는 상태 유지',
      '인계: 운영 매뉴얼 · 배포 절차 · 장애 대응 문서를 01/15 제출하고 운영 책임자를 지정',
    ],
    talk: '컨테이너는 배포 일관성을 돕지만 고가용성과 보안을 자동으로 보장하지는 않는다고 솔직하게 말합니다. 운영 인프라의 구성과 책임 주체(사내 전산 / 수행사 / 외부)를 별도로 합의해야 한다고 짚고, 전환일과 되돌리기 판단 기준을 미리 정하자고 제안합니다.',
  },
  {
    t: '보안 · 리스크 및 대응 계획',
    key: '주요 위험을 먼저 드러내고 담당자 · 대응 기한을 지정합니다.',
    lines: [
      '[높음] 기존 자료 수령 지연 → 11월 말 1차 스냅샷 · 창구 · 담당자 오늘 확정',
      '[높음] 운영 환경 미확정 → 12월 첫 주까지 확정(사내 Linux 우선 권고)',
      '[중간] 기존 데이터 불일치 → 이행 리허설에서 조기 발견 · 정리 범위 협의',
      '[중간] 도면 유출 위험 → 워터마크 · 열람이력 · 다운로드 상한(1차) 우선',
      '보안 보완 과제 25건 중 높음 7건은 구조에서 해소 — nginx 접근통제 · 업로드 검증 · 선언형 권한 · 자동 배포/롤백',
    ],
    talk: '위 두 건은 고객사 결정이 없으면 수행사가 손쓸 수 없는 항목이라고 분명히 말합니다. 비난이 아니라 일정 보호를 위한 요청이라는 톤을 유지합니다. 리스크는 가능성 · 영향도 · 대응책 · 담당자 · 기한으로 관리하고 해소될 때까지 주간 보고에서 닫지 않는다고 설명합니다.',
  },
  {
    t: '커뮤니케이션 및 의사결정 체계',
    key: '정기 보고와 단일 이슈 채널을 통해 문제를 빠르게 공유하고 결정합니다.',
    lines: [
      'Daily: 개발 진행 · 블로커 공유(필요 시 비동기)',
      'Weekly: 진척 · 이슈 · 리스크 · 다음 주 계획을 한 장으로',
      'Milestone: 산출물 시연 및 공식 검토 · 승인',
      'Issue: 담당자 → PM → 양사 책임자로 에스컬레이션',
      'Record: 회의록에 결정 사항 · 담당자 · 기한을 남기고 당일 공유',
    ],
    talk: '회의 횟수보다 결정의 추적성이 중요하다고 말합니다. 구두 합의만으로 범위를 바꾸지 않는다는 원칙을 다시 확인하고, 주간 보고 요일과 형식, 이슈 접수 채널을 오늘 정해 달라고 요청합니다.',
  },
  {
    t: '프로젝트 성공 기준 및 다음 액션',
    key: '성공은 합의된 범위의 구현 · 증명 · 검수 · 인계가 모두 끝난 상태입니다.',
    lines: [
      '완료 기준 ①: 기능 체크리스트 전수 통과 · 도면 · MDB 전량 이행 + sha256 전수 일치',
      '완료 기준 ②: 성능 기준 자동 검사 통과 · 반출 → 반입 → 검수 → 승인 1회전 성공',
      '다음 액션(고객사): 자료 1차 전달 11/27 · 검증 CM 지정 11/27 · 운영 환경 확정 12/04',
      '다음 액션(양사): 기준선 승인 11/27 · 유출 방지 범위 12/04 · 인수 기준 · UAT 시나리오 12/11',
    ],
    talk: '마지막으로 결정된 사항과 미결 사항을 다시 읽고 각 액션의 담당자와 완료일을 확인합니다. 자료 전달(11/27)과 운영 환경 확정(12/04) 두 건이 일정에 직접 영향을 준다는 점을 한 번 더 말합니다. Q&A 후 회의록을 당일 공유하고 확인을 요청하겠다고 마무리합니다.',
  },
]

const MILESTONES = [
  ['W1~W2 (11/17~11/27)', '착수 · 현행 분석 · 요구사항 및 범위 확정', '요구사항 · 범위 기준선 승인'],
  ['W2~W3 (11/23~12/04)', '설계 확정 · 운영 환경 결정 · 이행 설계 착수', '설계 및 환경 확정 승인'],
  ['W3~W5 (11/30~12/18)', '차이분 구현 · 변환 워커 구성', '핵심 기능 시연 승인'],
  ['W4~W6 (12/07~12/25)', '데이터 이행 리허설 2회 · 전수 검증', '이행 리허설 결과 승인'],
  ['W6~W7 (12/21~01/01)', '통합 · 성능 · 보안 점검', 'UAT 진입 기준 충족'],
  ['W7~W8 (12/28~01/08)', '섀도 비교 운영 2주 · UAT · 교육', 'UAT 승인'],
  ['W9 (01/11~01/15)', '본 이행 · 전환 · 인수 인계', '최종 검수 및 운영 인계 승인'],
]

const DECISIONS = [
  '운영 환경(사내 Linux 서버 / AWS 이관)과 DB 구성',
  '기존 DB · 파일 전달 창구 · 담당자 · 1차 제공 시점',
  '요구사항 · 범위 기준선 승인권자와 검토 리드타임',
  '검증 참여 CM(1~2명)과 섀도 비교 · UAT 참여 방식',
  '도면 유출 방지 적용 범위(1차: 워터마크 · 열람이력 · 다운로드 상한)',
  '인수 기준 · UAT 시나리오 · 최종 검수 절차',
  '이슈 접수 채널 · 주간 보고 요일 · 회의록 확인 절차',
  '본 이행 가능 시간대(업무 외)와 전환일 · 되돌리기 판단 기준',
]

const TIMEBOX = [
  ['11:00~11:03 (3분)', '표지 · 합의할 사항 (장 1~2)'],
  ['11:03~11:11 (8분)', '배경 · 목표 · 범위 · 사용자 기능 (장 3~6)'],
  ['11:11~11:18 (7분)', '요구사항 관리 · 사전 준비분 · 아키텍처 · 기술 (장 7~10)'],
  ['11:18~11:26 (8분)', '데이터 · API · 9주 일정 · 산출물 · 조직 (장 11~14)'],
  ['11:26~11:32 (6분)', '협업 · 품질 · 배포 · 리스크 · 커뮤니케이션 (장 15~19)'],
  ['11:32~11:40 (8분)', '성공 기준 · 다음 액션 확정 · Q&A (장 20)'],
]

const PRECHECK = [
  '양사 참석자와 역할(특히 고객사 업무 의사결정자)을 확인하고 14번 장 조직도에 반영합니다.',
  '20번 장의 다음 액션은 담당자와 기한이 비어 있지 않은지 확인합니다. 오늘 채우는 것이 목표입니다.',
  '8번 장(사전 준비분)은 "이미 다 끝났다"로 들리지 않도록 기준선 대조 전 상태임을 반드시 말합니다.',
  '시연을 요청받을 수 있으므로 화면 접속과 시험 계정을 미리 준비합니다.',
  '일정은 11/17 착수 · 01/15 완료 기준입니다. 자료 수령과 환경 확정이 늦어지면 같은 만큼 이동한다고 안내합니다.',
  '데이터 이행은 별도 장이 없습니다 — 5번(범위) · 12번(일정) · 18번(리스크)에서 나눠 설명합니다.',
  '보안 · AWS 이관 요건서의 인프라 과제는 별도 단계로 분리해 설명합니다(범위 혼동 방지).',
]

/* ── 문단 helper ───────────────────────────────────────────── */
const P = (text, o = {}) => new Paragraph({
  spacing: { before: o.before === undefined ? 0 : o.before, after: o.after === undefined ? 100 : o.after,
    line: 300, lineRule: 'auto' },
  alignment: o.align,
  indent: o.indent,
  border: o.border,
  children: [new TextRun({ text, bold: o.bold, italics: o.italics, size: o.size || 20,
    color: o.color || '2B3139', font: FONT })],
})

const RUNS = (runs, o = {}) => new Paragraph({
  spacing: { before: o.before || 0, after: o.after === undefined ? 100 : o.after, line: 300, lineRule: 'auto' },
  indent: o.indent,
  children: runs.map(r => new TextRun({ text: r.t, bold: r.b, color: r.c || '2B3139', size: r.s || 20, font: FONT })),
})

const BULLET = (text, o = {}) => new Paragraph({
  numbering: { reference: 'guide-bullets', level: 0 },
  spacing: { before: 0, after: 60, line: 290, lineRule: 'auto' },
  children: [new TextRun({ text, size: o.size || 19, color: o.color || '2B3139', font: FONT })],
})

const cell = (text, o = {}) => new TableCell({
  width: { size: o.w, type: WidthType.DXA },
  shading: o.shade ? { type: ShadingType.CLEAR, fill: o.shade, color: 'auto' } : undefined,
  margins: { top: 80, bottom: 80, left: 120, right: 120 },
  children: [new Paragraph({
    spacing: { before: 0, after: 0, line: 280, lineRule: 'auto' },
    children: [new TextRun({ text, bold: o.b, size: 18, color: o.c || '2B3139', font: FONT })],
  })],
})

/* ── 본문 조립 ─────────────────────────────────────────────── */
const body = []

body.push(new Paragraph({
  spacing: { after: 60 },
  children: [new TextRun({ text: '도면관리 시스템(TDMS) 구축 Kick-off 발표자 가이드',
    bold: true, size: 36, color: NAVY, font: FONT })],
}))
body.push(RUNS([{ t: 'SK가스 G.Hub 사업장 도면(TDB) · 설비 데이터북(MDB) 관리 시스템  ·  2026. 11. 17. ~ 2027. 01. 15. (9주)', c: BLUE, s: 20, b: true }], { after: 40 }))
body.push(new Paragraph({
  spacing: { after: 200 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: 'CFDEEC', space: 8 } },
  children: [new TextRun({ text: 'Kick-off 2026. 11. 24. (화) 11:00~11:40 · 정비동 회의실  |  고객사 지허브 · 수행사 진네트웍스  |  Vue 3 · Fastify(Node 22) · PostgreSQL 16 · Python 워커 · Docker',
    size: 18, color: MUTED, font: FONT })],
}))

body.push(P('작성 기준: 고객사와 수행사가 함께 참석하는 통합 Kick-off. 발표 자료 tdms_project_kickoff_20slides.pptx(20장)와 1:1로 대응합니다. 수치는 기존 시스템 소스·DB 전수 분석(2026-10-12 전달본, 11-12 갱신본)과 신규 시스템 실측에 근거하며, 고객사 확정이 필요한 항목은 본문에 표시했습니다.',
  { color: GREY, size: 19, after: 200 }))

body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: '발표 전 확인 사항', bold: true, size: 26, color: NAVY, font: FONT })] }))
;PRECHECK.forEach(t => body.push(BULLET(t)))

body.push(new Paragraph({ spacing: { before: 200, after: 0 }, children: [new PageBreak()] }))

SLIDES.forEach((sl, i) => {
  const no = String(i + 1).padStart(2, '0')
  body.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: i === 0 ? 0 : 320, after: 120 },
    children: [new TextRun({ text: `${no}. ${sl.t}`, bold: true, size: 26, color: NAVY, font: FONT })],
  }))
  body.push(new Paragraph({
    spacing: { before: 0, after: 120, line: 290, lineRule: 'auto' },
    indent: { left: 120 },
    border: { left: { style: BorderStyle.SINGLE, size: 12, color: BLUE, space: 10 } },
    children: [
      new TextRun({ text: '핵심 메시지  ', bold: true, size: 19, color: BLUE, font: FONT }),
      new TextRun({ text: sl.key, bold: true, size: 19, color: '1B4A72', font: FONT }),
    ],
  }))
  body.push(RUNS([{ t: '슬라이드 문구', b: true, c: NAVY, s: 19 }], { before: 60, after: 60 }))
  sl.lines.forEach(t => body.push(BULLET(t)))
  body.push(RUNS([{ t: '발표자 설명', b: true, c: NAVY, s: 19 }], { before: 120, after: 60 }))
  body.push(P(sl.talk, { color: GREY, size: 19, after: sl.visual ? 60 : 120 }))
  if (sl.visual) body.push(P(`도식 · 시각화: ${sl.visual}`, { color: MUTED, size: 18, italics: true, after: 120 }))
})

body.push(new Paragraph({ spacing: { before: 200, after: 0 }, children: [new PageBreak()] }))

body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: '9주 마일스톤 요약', bold: true, size: 26, color: NAVY, font: FONT })] }))
const COLS = [2600, 4200, 2600]
body.push(new Table({
  columnWidths: COLS,
  width: { size: COLS.reduce((a, b) => a + b, 0), type: WidthType.DXA },
  rows: [
    new TableRow({
      tableHeader: true,
      children: [
        cell('기간', { w: COLS[0], b: true, shade: 'EDF3F9', c: NAVY }),
        cell('주요 활동', { w: COLS[1], b: true, shade: 'EDF3F9', c: NAVY }),
        cell('완료 기준', { w: COLS[2], b: true, shade: 'EDF3F9', c: NAVY }),
      ],
    }),
    ...MILESTONES.map((r, i) => new TableRow({
      children: [
        cell(r[0], { w: COLS[0], b: true, shade: i % 2 ? 'F7F9FB' : undefined }),
        cell(r[1], { w: COLS[1], shade: i % 2 ? 'F7F9FB' : undefined }),
        cell(r[2], { w: COLS[2], shade: i % 2 ? 'F7F9FB' : undefined }),
      ],
    })),
  ],
}))
body.push(P('※ 각 완료 기준은 고객사 승인 시점입니다. 승인 지연은 그대로 일정 지연으로 반영됩니다.',
  { color: MUTED, size: 18, before: 120, after: 240 }))

body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Kick-off 회의에서 확정할 결정사항', bold: true, size: 26, color: NAVY, font: FONT })] }))
DECISIONS.forEach(t => body.push(BULLET(t)))

body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 120 }, children: [new TextRun({ text: '시간 배분 (40분)', bold: true, size: 26, color: NAVY, font: FONT })] }))
const C2 = [2200, 7200]
body.push(new Table({
  columnWidths: C2,
  width: { size: C2[0] + C2[1], type: WidthType.DXA },
  rows: TIMEBOX.map((r, i) => new TableRow({
    children: [
      cell(r[0], { w: C2[0], b: true, shade: i % 2 ? 'F7F9FB' : undefined }),
      cell(r[1], { w: C2[1], shade: i % 2 ? 'F7F9FB' : undefined }),
    ],
  })),
}))
body.push(P('※ 질의가 길어지면 장 15~19를 요약하고 20번 장의 다음 액션에 시간을 남깁니다. 오늘 결론이 필요한 것은 결정 사항뿐입니다.',
  { color: MUTED, size: 18, before: 120 }))

/* ── 문서 ──────────────────────────────────────────────────── */
const doc = new Document({
  creator: '진네트웍스',
  title: '도면관리 시스템(TDMS) 구축 Kick-off 발표자 가이드',
  description: '2026.11.17 ~ 2027.01.15 (9주) · 발표 자료 20장 대응',
  styles: {
    default: {
      document: { run: { font: FONT, size: 20, color: '2B3139' }, paragraph: { spacing: { line: 300, lineRule: 'auto' } } },
      heading1: { run: { font: FONT, size: 26, bold: true, color: NAVY },
        paragraph: { spacing: { before: 320, after: 120 }, keepNext: true } },
      heading2: { run: { font: FONT, size: 22, bold: true, color: NAVY },
        paragraph: { spacing: { before: 240, after: 100 }, keepNext: true } },
    },
  },
  numbering: {
    config: [{
      reference: 'guide-bullets',
      levels: [{
        level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 360, hanging: 200 } }, run: { font: FONT, color: BLUE } },
      }],
    }],
  },
  sections: [{
    properties: { page: { margin: { top: 1100, right: 1100, bottom: 1100, left: 1100 } } },
    children: body,
  }],
})

Packer.toBuffer(doc).then(buf => { fs.writeFileSync(OUT, buf); console.log('wrote', OUT, buf.length) })
