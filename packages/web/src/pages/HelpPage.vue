<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useSession } from '@/lib/session'

/**
 * 도움말 — 화면별 사용법과 업무 흐름 (기존 help.html 의 구성을 새 화면에 맞춰 옮겼다).
 *
 *   · 왼쪽 목차 — 누르면 그 절로 간다
 *   · 검색 — 궁금한 말을 넣으면 그 말이 들어 있는 항목만 남긴다
 *   · 인쇄 — 브라우저 인쇄(PDF 로 저장 포함). 메뉴·상단바는 빼고 본문만 나간다
 *
 * 본문은 아래 SECTIONS 한 곳에 모았다 — 화면이 바뀌면 여기만 고친다.
 * 본문 HTML 은 이 파일에 적힌 고정 문구뿐이다(사용자 입력이 들어가지 않는다).
 */

const session = useSession()

interface Item { title: string; html: string }
interface Section { id: string; title: string; lead?: string; items: Item[] }

const SECTIONS: Section[] = [
  {
    id: 'start', title: '처음 오셨다면',
    items: [
      { title: '이 시스템은 무엇을 하나요', html: `
        <p>G.Hub 사업장의 도면과 기술자료를 한곳에 모아 두고, <b>찾아보고 · 열어보고 · 업체에 보내고 · 고쳐서 돌려받는</b>
        일을 기록으로 남기는 시스템입니다. 공유 폴더를 뒤지는 대신 이 화면에서 찾고, 누가 언제 무엇을 가져갔는지가 자동으로 남습니다.</p>
        <dl>
          <dt>TDB</dt><dd>도면·기술자료 묶음입니다. 계산서·도면·리스트·사양서처럼 공사 서류 전체가 들어 있습니다. 왼쪽 메뉴의 "도면 (TDB)" 묶음이 여기에 해당합니다.</dd>
          <dt>MDB</dt><dd>설비자료(Mechanical Data Book) 묶음입니다. 펌프·탱크 같은 설비 한 대를 기준으로 정리되어 있고, Tag No(설비번호)로 찾습니다. 리비전·반출·검수가 없는 고정 기록입니다.</dd>
        </dl>` },
      { title: '세 줄 요약', html: `
        <ul>
          <li><b>찾기</b> — [TDB 조회] 또는 [MDB 조회]에서 왼쪽 폴더를 누르거나 검색창에 자료명을 넣습니다.</li>
          <li><b>보기 · 받기</b> — 자료 줄을 누르면 상세 화면이 열립니다. [미리보기] 탭에서 PDF·DWG 를 바로 보고, 위쪽 버튼으로 파일을 내려받습니다.</li>
          <li><b>주고받기</b> — 업체에 보낼 자료는 반출대기함에 담아 한 번에 내보내고, 업체가 고쳐 보낸 자료는 [TDB 반입·검수]에서 확인하고 승인하면 최신본이 바뀝니다.</li>
        </ul>` },
      { title: '접속 방법', html: `
        <p>사내망에서 브라우저 주소창에 시스템 주소를 넣으면 로그인 화면이 나옵니다. 아이디와 비밀번호는 관리자에게 받으세요.
        주소를 즐겨찾기에 등록해 두면 편합니다.</p>` },
    ],
  },
  {
    id: 'login', title: '로그인과 내 계정',
    items: [
      { title: '로그인 · 로그아웃', html: `
        <ul>
          <li>아이디와 비밀번호를 넣고 [로그인]을 누릅니다. 접속 가능한 첫 화면이 열립니다.</li>
          <li>일을 마치면 오른쪽 위 내 이름을 눌러 [로그아웃]을 누릅니다.</li>
          <li>로그인에 여러 번 실패하면 잠시 잠깁니다. 시간이 지나면 다시 시도할 수 있습니다.</li>
        </ul>
        <p class="note">한동안 쓰지 않으면 로그인이 풀려 로그인 화면으로 돌아갑니다. 오류가 아니니 다시 로그인하면 됩니다.</p>` },
      { title: '처음 로그인 · 비밀번호 바꾸기', html: `
        <p>처음 받은 비밀번호(초기 비밀번호)로 들어오면 비밀번호 변경 화면이 먼저 열립니다. 바로 바꾸거나 [나중에]로 미룰 수 있고,
        미루면 이번 로그인 동안만 건너뜁니다. 비밀번호를 잊었으면 관리자에게 [비번 초기화]를 요청하세요.</p>` },
      { title: '메뉴가 안 보이거나 버튼이 흐릴 때', html: `
        <p>쓸 수 있는 기능은 사람마다 다릅니다. 화면에 들어갈 권한이 없으면 왼쪽 메뉴에 그 화면이 나오지 않고,
        화면 안의 기능 권한이 없으면 버튼이 흐리게 보이며 눌리지 않습니다(마우스를 올리면 이유가 나옵니다).
        필요하면 관리자에게 권한을 요청하세요.</p>` },
    ],
  },
  {
    id: 'common', title: '모든 화면에서 똑같이 쓰는 것',
    items: [
      { title: '왼쪽 메뉴와 상단바', html: `
        <ul>
          <li><b>왼쪽 메뉴</b> — 도면(TDB) · 데이터북(MDB) · 운영 묶음으로 나뉩니다. 묶음 이름을 누르면 접고 펼칩니다.
            상단바 왼쪽 ☰ 버튼으로 메뉴를 좁게 접어 본문을 넓힐 수 있습니다(이 선택은 기억됩니다).</li>
          <li><b>화면 이름</b> — 상단바의 화면 이름을 누르면 [현재 URL 복사]가 나옵니다. 지금 보는 화면 주소를 동료에게 보낼 때 씁니다.</li>
          <li><b>[보관 N]</b> — 미리보기에서 보관해 둔 자료 목록(사용자 보관 목록)을 엽니다. 숫자는 보관한 건수입니다. → <a href="#help-preview">미리보기와 사용자 보관</a></li>
          <li><b>☾ / ☀</b> — 화면을 어둡게·밝게 바꿉니다.</li>
          <li><b>내 이름</b> — 아이디·그룹 확인, [도움말], [로그아웃].</li>
        </ul>` },
      { title: '왼쪽 폴더 트리', html: `
        <ul>
          <li>폴더 이름을 누르면 그 폴더의 자료만 오른쪽 표에 나옵니다. 왼쪽 세모(▸)를 누르면 하위 폴더가 펼쳐집니다.</li>
          <li>폴더 옆 숫자는 그 폴더(하위 포함)에 든 자료 건수입니다.</li>
          <li>펼칠 때 그 폴더의 바로 아래만 불러오므로 큰 트리도 빠르게 열립니다.</li>
        </ul>` },
      { title: '표 다루기', html: `
        <ul>
          <li><b>정렬</b> — 머리글을 누르면 정렬됩니다. 목록 화면은 불러온 것만이 아니라 <b>검색 결과 전체</b>를 서버가 정렬하므로, 정렬 후 첫 줄이 진짜 첫 번째입니다.</li>
          <li><b>칸별 거르기</b> — 머리글 아래 칸에 글자를 넣으면 지금 불러온 줄 안에서 바로 거릅니다(빠른 훑기용).</li>
          <li><b>열 너비</b> — 머리글 사이 경계선을 끌면 넓어집니다. 화면마다 기억됩니다.</li>
          <li><b>더 불러오기</b> — 목록은 200건씩(바꿀 수 있음) 불러오고, 표 끝까지 내리면 다음 묶음을 이어 불러옵니다.
            표 아래에 전체·불러온·보이는·선택 건수가 함께 나옵니다.</li>
        </ul>` },
      { title: '엑셀 내보내기', html: `
        <p>표 아래 오른쪽에 엑셀 버튼이 있습니다.</p>
        <dl>
          <dt>엑셀 (화면 그대로)</dt><dd>지금 불러와서 보이는 줄을, 지금의 칸 순서·거르기 그대로 바로 내려받습니다.</dd>
          <dt>전체 엑셀 (서버 작업)</dt><dd>TDB 조회 · MDB 조회 · 시스템 로그에 있습니다. 지금 걸어 둔 <b>검색 조건 그대로 전체</b>를 서버가 만들어 줍니다.
            건수가 많아도 화면이 멈추지 않고, 아래에 진행률이 나온 뒤 [받기]가 나타납니다.</dd>
        </dl>
        <p class="note">조건을 먼저 맞춘 뒤 누르세요. 파일 이름에는 화면 이름과 날짜·시간이 붙습니다.</p>` },
      { title: '오래 걸리는 작업 (Zip · 엑셀 · 백업)', html: `
        <p>Zip 만들기·전체 엑셀·백업은 뒤에서 만듭니다. 진행률 막대가 보이고, 끝나면 [받기]가 나타납니다.
        화면을 떠나도 작업은 계속됩니다.</p>` },
      { title: '자주 나오는 말', html: `
        <dl>
          <dt>원본 / 사본</dt><dd>원본은 DWG·엑셀처럼 고칠 수 있는 파일이고, 사본은 PDF 입니다.</dd>
          <dt>Rev (리비전)</dt><dd>그 자료가 몇 번째로 고쳐진 것인지 나타내는 번호입니다. 0 은 처음 등록된 상태입니다.</dd>
          <dt>반출 / 반입</dt><dd>자료를 업체에 내보내는 것 / 업체가 고쳐 보낸 자료를 다시 넣는 것입니다.</dd>
          <dt>검수</dt><dd>반입된 자료가 맞는지 확인하고 승인·반려하는 절차입니다. 승인해야 최신본이 바뀝니다.</dd>
          <dt>Isometric</dt><dd>배관 아이소메트릭 도면입니다. 건수가 매우 많아 기본 목록에서 빼고, [Isometric 보기]로 켭니다.</dd>
        </dl>` },
    ],
  },
  {
    id: 'preview', title: '미리보기와 사용자 보관',
    lead: '자료 상세의 [미리보기] 탭에서 PDF 와 도면 원본을 바로 보고, 그 위에 표시를 그려 보관해 둘 수 있습니다.',
    items: [
      { title: 'PDF 보기와 편집 도구', html: `
        <ul>
          <li>확대·축소·회전·쪽 넘기기·찾기·인쇄·다운로드를 뷰어 도구모음에서 합니다.</li>
          <li>도형(사각형·원·화살표·밸브 등)·문구·형광펜·도장(스탬프)을 그 위에 그릴 수 있습니다. 그린 것은 원본 파일을 바꾸지 않습니다.</li>
          <li>그린 채로 [다운로드]하면 파일 이름에 <b>(Markup)</b>이 붙은 PDF 로 받아집니다.</li>
          <li>도장 모양은 [스탬프 관리] 화면에서 관리자가 정합니다.</li>
        </ul>` },
      { title: '원본(DWG·DXF) 보기와 원본/사본 전환', html: `
        <p><b>DWG·DXF 도면도 화면에서 바로 볼 수 있습니다.</b> 서버가 도면을 미리보기용 PDF 로 바꿔 보여 주며,
        처음 여는 도면은 바꾸는 동안 몇 초 기다립니다(한 번 바꾼 도면은 다음부터 바로 열립니다).</p>
        <ul>
          <li>같은 자료에 원본과 사본(PDF)이 함께 있으면 미리보기에서 <b>원본 · 사본(PDF)</b>을 바꿔 볼 수 있습니다.
            TDB 는 미리보기 위쪽 버튼으로, MDB 는 뷰어 도구모음의 [원본(DWG)] · [사본(PDF)] 버튼으로 바꿉니다.</li>
          <li>원본 창에서 그린 것을 [다운로드]하면 <b>자료명(Dwg_Markup).pdf</b> 처럼 받아집니다.</li>
          <li>엑셀·워드·파워포인트 원본은 화면에서 열지 않습니다. 짝 PDF 로 보거나 내려받아 해당 프로그램에서 여세요.</li>
        </ul>` },
      { title: '보관하기 · 다른 이름으로 보관', html: `
        <p>뷰어 도구모음 오른쪽 끝 <b>[»]</b> 안에 두 버튼이 있습니다. 보관하는 것은 자료의 사본이 아니라
        <b>그 자료로 가는 바로가기 + 그려 둔 편집 내용</b>입니다. 자료는 하나도 바뀌지 않습니다.</p>
        <dl>
          <dt>보관하기</dt><dd>처음이면 새로 보관하고, 이미 보관한 것이 있으면 그 자리에 덮어씁니다. 이름은 언제나 자료명 그대로입니다.</dd>
          <dt>다른 이름으로 보관</dt><dd>이름을 새로 적어 한 벌 더 보관합니다. 처음 보관할 때는 쓸 수 없습니다.</dd>
        </dl>
        <ul>
          <li>이미 보관돼 있고 편집한 것이 없으면 두 버튼이 잠깁니다(똑같은 것이 두 벌 생기지 않게).</li>
          <li>보관 팝업의 "보관 위치" 표에는 보관해 둔 것 전부가 나옵니다. 덮어쓸 자리를 고르거나, 쓰지 않는 것을 [삭제]로 비울 수 있습니다.
            지금 보고 있는 자료의 자리에는 <b>이 자료</b> 표시가 붙습니다.</li>
          <li>한 사람이 <b>50개</b>까지 보관할 수 있습니다.</li>
        </ul>` },
      { title: '보관 목록 (상단 [보관 N])', html: `
        <ul>
          <li>자료명을 누르면 그 자료의 상세 화면이 열리고, 미리보기에 그려 두었던 편집 내용이 그대로 되살아납니다(이어서 옮기고 지우고 색을 바꿀 수 있습니다).</li>
          <li>자료명 왼쪽 🔍 는 보던 화면을 그대로 둔 채 한 겹 위에 미리보기를 띄웁니다.</li>
          <li>설명 칸의 ✎ 로 설명을 고칩니다. 체크한 뒤 [선택 삭제]로 지우고, [엑셀 내보내기]로 목록을 받습니다.</li>
          <li><b>상태</b> — 자료가 삭제 보관함에 들어갔거나 완전히 지워졌으면 "삭제됨", 자료명이 바뀌었으면 "이름 바뀜"이 붙습니다.
            리비전이 올라간 것만으로는 표시하지 않습니다.</li>
          <li>보관 목록은 본인만 봅니다. 지워도 자료·파일·이력은 그대로 남습니다.</li>
        </ul>` },
    ],
  },
  {
    id: 'tdb-list', title: 'TDB 조회',
    lead: '도면·기술자료를 찾고, 열어 보고, 업체로 반출하는 화면입니다.',
    items: [
      { title: '자료 찾기', html: `
        <ul>
          <li>왼쪽 트리에서 폴더를 고르거나, 검색창에 자료명을 넣습니다(입력을 멈추면 바로 찾습니다).</li>
          <li><b>검색대상</b> — 자료명 / 폴더명.</li>
          <li><b>상태</b> — 전체 / 정상 / 검수 / 반출 / 삭제.</li>
          <li><b>원본/사본</b> — 원본/사본 있음 · 원본만 있음 · 사본만 있음. 짝이 안 맞는 자료를 찾을 때 씁니다.</li>
          <li><b>Isometric 보기</b> — 평소 빠져 있는 아이소메트릭 도면을 함께 봅니다.</li>
          <li>조건이 꼬였으면 ↺ (조건 초기화)를 누릅니다.</li>
        </ul>` },
      { title: '자료 상세', html: `
        <ul>
          <li>줄을 누르면 상세 화면이 열립니다. [◀ 이전] · [다음 ▶]으로 옆 자료로 넘어갑니다.</li>
          <li>탭: 자료내용 · 미리보기 · Revision 이력 · 반출 이력.</li>
          <li>미리보기에는 <b>현재 리비전의 PDF</b>가 나옵니다. 현재본에 PDF 가 없으면 옛 PDF 를 최신처럼 보여 주지 않고, 원본 도면을 보여 주거나 "이전 Rev" 임을 밝히고 고를 때만 엽니다.</li>
          <li>자료내용 탭에서 업체를 골라 반입등록(개별 자료)을 할 수 있습니다(권한이 있을 때).</li>
        </ul>` },
      { title: '업체로 반출하기', html: `
        <ol>
          <li>표에서 보낼 자료를 체크하면 아래 <b>반출대기함</b>에 담깁니다.</li>
          <li>[이 목록으로 반출하기]를 누릅니다.</li>
          <li>업체·공사·목적(수정용 / 참조용 / 기타)을 고르고, 필요하면 비고와 [폴더 경로 유지]를 정합니다.</li>
          <li>[반출]을 누르면 기록이 남고 Zip 은 뒤에서 만들어집니다. 진행률이 끝나면 받아서 업체에 보냅니다.</li>
        </ol>
        <p class="note">이미 다른 업체가 수정 중인 자료를 또 수정용으로 보내면 경고가 뜹니다. 막지는 않지만, 나중에 두 업체의 수정본을 사람이 합쳐야 합니다.</p>` },
    ],
  },
  {
    id: 'tdb-import', title: 'TDB 반입·검수',
    lead: '업체가 고쳐 보낸 자료를 등록하고, 맞는지 확인해 승인·반려하는 화면입니다.',
    items: [
      { title: '반입등록', html: `
        <ul>
          <li>업체가 보낸 Zip 을 그대로 올립니다. 시스템이 Zip 안의 반출목록 엑셀과 폴더 구조를 읽어 어떤 자료의 수정본인지 스스로 찾습니다.</li>
          <li>Zip 이 아닌 낱개 파일은 [TDB 조회] → 자료 상세 → 자료내용 탭의 반입등록(개별 자료)으로 올립니다.</li>
          <li>문제없이 붙은 것은 <b>검수 대기</b>로, 어긋난 것은 <b>확인 필요</b>로 갑니다. 파일은 사라지지 않습니다.</li>
        </ul>` },
      { title: '검수 대기 — 승인 · 반려', html: `
        <ul>
          <li>반출Rev / 반입Rev, 반출자료 / 반입자료를 나란히 보고 판단합니다.</li>
          <li><b>[승인]</b> — 이 자료가 최신본이 됩니다. 리비전 번호가 1 오르고 이전 파일은 이력으로 넘어갑니다.</li>
          <li><b>[반려]</b> — 되돌립니다. 번호는 오르지 않고 1-a, 1-b 처럼 글자만 붙어 이력에 남습니다.</li>
        </ul>` },
      { title: '두 업체가 같은 도면을 고쳤을 때', html: `
        <p>업체별 수정본이 분기 리비전(예: Rev3-a / Rev3-b)으로 <b>각각</b> 보관되고 자료에 "병합 필요"가 붙습니다.
        시스템은 도면을 합쳐 주지 않습니다 — 사람이 CAD 에서 통합한 파일을 올려야 정식 Rev 가 됩니다.</p>` },
      { title: '확인 필요', html: `
        <p>자동으로 짝을 맞추지 못한 자료가 모입니다(자료명 불일치·경로 불일치·원본 또는 사본 누락·반출 대상 아님 등).
        사유를 보고 짐작한 자료를 고르거나 다시 받아 처리합니다.</p>` },
    ],
  },
  {
    id: 'tdb-editor', title: 'TDB 관리',
    lead: '업체와 주고받는 절차 없이 폴더와 자료를 직접 정리하는 화면입니다. 여기서 한 일은 검수 없이 바로 반영됩니다.',
    items: [
      { title: '폴더 편집', html: `
        <ul>
          <li>폴더 만들기 · 이름 변경 · 옮기기 · 삭제(삭제 보관함으로).</li>
          <li>같은 자리에 같은 이름은 만들 수 없습니다. 이름 변경·이동은 자료를 건드리지 않습니다.</li>
          <li><b>원본·사본 폴더 병합</b> — CAD 폴더와 PDF 폴더가 따로 등록된 곳을 찾아, 이름이 같은 원본·PDF 를 자료 1건으로 합칩니다.</li>
        </ul>` },
      { title: '자료 편집', html: `
        <ul>
          <li>자료를 골라 옮기기 · 삭제(삭제 보관함으로) 등을 합니다. 여러 건을 함께 고를 수 있습니다.</li>
          <li>내가 직접 고친 파일로 바꾸거나 새 자료를 등록할 때도 이 화면을 씁니다.</li>
        </ul>` },
      { title: '삭제 보관함 · 폐기 보관함', html: `
        <dl>
          <dt>삭제 보관함</dt><dd>오류 등으로 못 쓰게 된 자료. 폴더째 묶여 한 줄입니다. [복구]로 원래 자리로 돌아오고,
            용량이 문제면 <b>[완전 삭제]</b>까지 갈 수 있습니다(되살릴 수 없습니다).</dd>
          <dt>폐기 보관함</dt><dd>리비전이 진행되며 최신본에서 빠진 자료. 이력을 찾아야 하므로 <b>완전 삭제가 없고 복구만</b> 있습니다.</dd>
        </dl>` },
    ],
  },
  {
    id: 'tdb-dist', title: 'TDB 반출이력',
    lead: '언제 · 누가 · 어떤 자료를 · 어느 업체로 보냈고, 돌아왔는지 보는 화면입니다.',
    items: [
      { title: '찾는 방법', html: `
        <ul>
          <li>공사 · 업체 · 목적 · 상태 · 반출자로 좁히고, 검색창에 자료명을 넣습니다.</li>
          <li><b>자료별 / Zip별</b> — 개별 자료 한 건씩 또는 한 번에 내보낸 묶음 단위로 봅니다.</li>
          <li><b>상태</b> — 반입미완료(안 옴) / 검수대기(들어와 확인 중) / 확인필요 / 반입완료.</li>
        </ul>` },
      { title: '수정 없이 돌아온 자료 정리', html: `
        <p>업체가 고칠 것이 없다며 그냥 돌려준 건은 체크한 뒤 [선택 반납처리]로 닫습니다. 기록 자체는 남습니다.</p>` },
    ],
  },
  {
    id: 'mdb-list', title: 'MDB 조회',
    lead: '설비 한 대를 기준으로 설비자료를 찾고 내려받는 화면입니다.',
    items: [
      { title: '찾는 방법', html: `
        <ul>
          <li>설비번호를 알면 검색대상을 [Tag No 검색]으로 바꾸고 번호를 넣습니다. 두 글자부터 비슷한 번호가 아래에 나와 고를 수 있습니다.</li>
          <li>[자료명 검색] · [폴더명 검색]으로도 찾고, 왼쪽 트리에서 폴더를 직접 눌러도 됩니다.</li>
          <li><b>분류</b> — 전체 / 전용(그 설비만의 자료) / 공용(여러 설비가 함께 쓰는 자료) / 확인필요(아직 어느 설비 것인지 정하지 못한 자료).</li>
          <li><b>설비유형 · 자료유형 · 공사 · 연도</b>로 좁힙니다. <b>하위폴더 전체보기</b>를 끄면 고른 폴더 바로 안의 자료만 봅니다.</li>
          <li>검색 조건·폴더·정렬은 이 창(탭)을 닫을 때까지 기억됩니다. 상세 화면에 갔다가 돌아와도 그대로입니다.</li>
        </ul>` },
      { title: '내려받기 (다운대기함)', html: `
        <ol>
          <li>표에서 체크하고 <b>[선택 다운]</b>, 또는 폴더를 고르고 <b>[폴더 다운]</b>(하위폴더 전체보기를 따릅니다)을 누르면 다운대기함에 담깁니다.</li>
          <li><b>[다운대기함 (N)]</b>을 열어 목록을 확인하고, 뺄 것은 체크해 [선택 제거]합니다. [엑셀 내보내기]로 목록을 받을 수도 있습니다.</li>
          <li><b>[이 목록으로 다운하기]</b>를 누르면 Zip 을 뒤에서 만들고, 끝나면 [받기]가 나타납니다. Zip 안은 원래 폴더 경로대로 담깁니다.</li>
        </ol>
        <p class="note">다운대기함은 검색을 바꾸거나 상세 화면에 다녀와도 그대로 남습니다(창을 닫으면 비워집니다). 한 번에 5,000건까지 담을 수 있습니다.</p>` },
      { title: '폐기 보관함 보기', html: `
        <p>[MDB 관리]에 들어갈 권한이 있으면 검색 줄 오른쪽에 [폐기 보관함]이 보입니다. 여기서는 <b>읽기만</b> 하고, 복구·비고 작성은 [MDB 관리]에서 합니다.</p>` },
      { title: 'MDB 자료 상세', html: `
        <ul>
          <li><b>[◀◀ 처음] [◀ 이전] n / 전체 [다음 ▶] [끝 ▶▶]</b> — 조회 화면의 검색 조건·정렬 그대로 넘겨 봅니다. 가운데 칸에 번호를 넣고 Enter 를 누르면 그 자리로 갑니다.</li>
          <li><b>✎</b> — 설비유형 · 자료유형 · Tag No · Note 를 그 자리에서 고칩니다([MDB 관리]의 자료 편집 권한이 있을 때). 어느 ✎ 를 눌러도 편집칸은 Note 아래에 열립니다.
            Tag No 는 쉼표로 나눠 여러 개를 적습니다.</li>
          <li>같은 이름의 원본(DWG 등)과 PDF 가 함께 있으면 <b>[원본(DWG) 다운로드]</b> · <b>[PDF 다운로드]</b>가 따로 나오고, 미리보기에서 원본·사본을 바꿔 봅니다.</li>
        </ul>` },
    ],
  },
  {
    id: 'mdb-editor', title: 'MDB 관리',
    lead: '설비자료의 폴더와 자료 정보를 정리하는 화면입니다. 쓰는 방법은 [TDB 관리]와 같고, 설비자료에만 있는 것이 몇 가지 더 있습니다.',
    items: [
      { title: 'TDB 관리와 같은 것', html: `
        <p>새 폴더 · 폴더 이름 변경 · 옮기기 · 폴더 삭제, 자료 옮기기 · 삭제, 삭제 보관함과 폐기 보관함(복구 · 비고 · 완전 삭제)을 같은 방법으로 씁니다.</p>` },
      { title: 'MDB 에만 있는 것', html: `
        <dl>
          <dt>자료 정보 변경</dt><dd>자료명 · 설비유형 · 자료유형 · 공사 · 연도 · 공용/전용 · 확인필요 · Tag No · Note 를 고칩니다. 한 자료에 Tag No 를 여러 개 달 수 있습니다.</dd>
          <dt>설비유형 일괄 변경</dt><dd>여러 자료를 골라 설비유형을 한꺼번에 바꿉니다.</dd>
          <dt>Tag 이력</dt><dd>설비 교체·체계 변경으로 Tag No 가 바뀌면, 바뀔 대상을 먼저 보고([대상 보기]) 한꺼번에 바꿉니다. 바꾼 것은 되돌릴 수 있습니다.</dd>
        </dl>` },
    ],
  },
  {
    id: 'audit', title: '시스템 로그',
    lead: '시스템에서 일어난 일이 시간 순으로 쌓입니다. "누가 이걸 언제 바꿨지?"를 확인할 때 봅니다. 기록은 수정하거나 지울 수 없습니다.',
    items: [
      { title: '무엇이 남나요', html: `
        <ul>
          <li>로그인 · 로그아웃 · 비밀번호 변경</li>
          <li>열람(PDF·도면 미리보기 포함) · 다운로드 · Zip · 엑셀 요청</li>
          <li>반출 · 반입 · 승인 · 반려, 폴더·자료 정보 변경, 보관함 이동·복구·완전 삭제</li>
          <li>사용자 · 권한 · 메뉴 · 백업 작업, 사용자 보관(보관 · 삭제 · 설명 수정)</li>
        </ul>` },
      { title: '찾는 방법', html: `
        <ul>
          <li><b>기간</b>(기본: 어제~오늘) · <b>화면</b> · <b>동작</b> · <b>사용자</b>로 좁히고, 검색창에는 자료명이나 사용자 이름을 넣습니다.</li>
          <li>화면과 동작은 <b>여러 개를 함께</b> 고를 수 있습니다. 버튼을 눌러 체크하고, [전체]로 모두 풉니다.</li>
          <li>상세가 있는 줄은 📄 를 누르면 상세 내용이 열립니다.</li>
          <li>[전체 엑셀 (서버 작업)]은 지금 조건(기간·화면·동작·사용자·자료명)에 맞는 기록 전부를 받습니다.</li>
        </ul>
        <p class="note">다른 사용자의 기록을 볼 권한이 없으면 자기 기록만 보이고, 엑셀도 자기 기록만 나옵니다.</p>` },
    ],
  },
  {
    id: 'users', title: '사용자 · 권한 · 메뉴 · 스탬프 관리',
    lead: '관리 권한이 있는 사람에게만 보이는 화면들입니다.',
    items: [
      { title: '사용자 관리', html: `
        <ul>
          <li>[사용자 추가]로 계정을 만들고, [수정]으로 이름·그룹·소속·연락처·상태를 바꿉니다.</li>
          <li>상태는 재직 / 퇴직 / 삭제입니다. 퇴직·삭제로 두면 로그인만 막히고 그 사람이 남긴 기록은 그대로 남습니다.</li>
          <li>[비번 초기화]를 하면 초기 비밀번호로 돌아가고, 다음 로그인 때 변경 화면이 열립니다.</li>
        </ul>` },
      { title: '접속권한 관리', html: `
        <ul>
          <li>권한은 <b>그룹</b>에 매기고, 사람은 그룹에 속합니다. 필요하면 사람별로 따로 더하거나 뺄 수 있습니다.</li>
          <li>상위 항목을 켜면 하위가 전부 켜집니다. 저장하는 즉시 적용됩니다(다시 로그인할 필요 없음).</li>
          <li>권한 트리에 없는 기능(예: 사용자 보관)은 로그인한 사람이면 누구나 씁니다. 관리자(ADMIN)는 모든 기능이 열립니다.</li>
        </ul>` },
      { title: '메뉴 관리 · 스탬프 관리', html: `
        <ul>
          <li><b>메뉴 관리</b> — 왼쪽 메뉴의 이름·순서·묶음·주소를 바꿉니다. 끌어서 순서를 바꿀 수 있습니다.</li>
          <li><b>스탬프 관리</b> — 미리보기에서 찍는 도장·서명·표의 모양·색·크기를 정합니다.</li>
        </ul>` },
    ],
  },
  {
    id: 'backup', title: '백업 관리',
    lead: 'DB(자료 정보)·자료 파일·코드를 묶어 백업을 만들고 내려받습니다.',
    items: [
      { title: '백업 만들기', html: `
        <ul>
          <li>범위(전체 / 변경분만)와 담을 항목(DB · 자료 파일 · 서버 코드 · 화면 코드), 저장 위치, 압축 여부를 고르고 [백업 만들기]를 누릅니다.</li>
          <li>만드는 일은 뒤에서 돌아가므로 화면이 멈추지 않습니다. 진행률이 끝나면 이력에 나타납니다.</li>
        </ul>` },
      { title: '백업 이력', html: `
        <ul>
          <li>회차 · 종류 · 담은 항목 · 크기 · 만든 시각 · 받은 횟수 · 상태가 나옵니다. [엑셀 내보내기]로 이력을 받습니다.</li>
          <li>[받기]로 묶음을 내려받고, 비고를 적어 둘 수 있습니다.</li>
          <li>[파일 삭제]는 백업 파일만 지웁니다. <b>이력 줄은 어떤 경우에도 지워지지 않습니다.</b></li>
          <li>되살리기는 묶음 안 안내 파일대로 사람이 수행합니다.</li>
        </ul>` },
    ],
  },
  {
    id: 'flow', title: '업무 흐름 한눈에 보기',
    items: [
      { title: '업체에 도면을 주고 수정본을 받는 전 과정', html: `
        <ol>
          <li><b>고른다</b> — [TDB 조회]에서 보낼 도면을 체크해 반출대기함에 담습니다.</li>
          <li><b>내보낸다</b> — [이 목록으로 반출하기] → 업체 · 공사 · 수정용 → [반출]. 만들어진 Zip 을 받아 업체에 보냅니다.</li>
          <li><b>받는다</b> — 업체가 보낸 Zip 을 [TDB 반입·검수]에 그대로 올립니다.</li>
          <li><b>확인한다</b> — 검수 대기에서 전후를 보고 맞으면 [승인], 아니면 [반려]합니다.</li>
          <li><b>정리한다</b> — 어긋난 것은 확인 필요에서 처리하고, 수정 없이 돌아온 건은 [TDB 반출이력]에서 반납처리로 닫습니다.</li>
          <li><b>끝</b> — 승인된 자료가 최신본이 되고 리비전 번호가 1 오릅니다.</li>
        </ol>` },
      { title: '내가 직접 고친 파일로 바꿀 때', html: `
        <p>업체를 거치지 않았으면 반출·반입이 필요 없습니다. [TDB 관리]에서 그 자료의 파일을 바꾸면 그 자리에서 최신본이 됩니다.</p>` },
      { title: '설비자료(MDB)를 모아 받을 때', html: `
        <p>[MDB 조회]에서 Tag No 로 찾고 → [선택 다운]·[폴더 다운]으로 담고 → [다운대기함]에서 확인한 뒤 → [이 목록으로 다운하기].</p>` },
    ],
  },
  {
    id: 'rules', title: '알아두면 좋은 규칙 · 문제가 생겼을 때',
    items: [
      { title: '자료를 지우는 기능이 없습니다', html: `
        <p>어느 화면에서 [삭제]를 눌러도 자료가 곧바로 없어지지 않고 보관함으로 옮겨집니다. [복구]하면 원래 자리로 돌아옵니다.
        정말로 없애는 곳은 삭제 보관함의 [완전 삭제] 한 곳뿐입니다.</p>` },
      { title: '리비전 번호는 시스템이 매깁니다', html: `
        <ul>
          <li>번호는 승인될 때만 1씩 오릅니다. 반려는 1-a, 1-b 처럼 글자만 붙어 이력에 남습니다.</li>
          <li>업체가 파일 이름에 적어 온 번호는 참고만 합니다. 다르면 경고만 뜨고 막지는 않습니다.</li>
        </ul>` },
      { title: '같은 이름의 자료가 여럿 있습니다', html: `
        <p>도면번호가 겹치는 자료(표지·목차 등)가 많습니다. 이름만 보지 말고 폴더(경로)까지 확인하세요.</p>` },
      { title: '한 일은 모두 기록됩니다', html: `
        <p>열람·다운로드까지 시스템 로그에 남고, 이 기록은 수정하거나 지울 수 없습니다.</p>` },
      { title: '자주 묻는 것', html: `
        <dl>
          <dt>메뉴가 안 보입니다</dt><dd>그 화면의 "페이지 접속" 권한이 없습니다. 관리자에게 요청하세요.</dd>
          <dt>DWG 가 미리보기에 안 나옵니다</dt><dd>처음 여는 도면은 서버가 바꾸는 동안 몇 초 기다려야 합니다. 그래도 "만들 수 없습니다"가 나오면 파일이 손상됐을 수 있으니 [원본 받기]로 받아 CAD 에서 여세요.</dd>
          <dt>PDF 가 없다고 나옵니다</dt><dd>지금 리비전에 PDF 가 없다는 뜻입니다. 옛 리비전의 PDF 를 최신처럼 보여 주지 않습니다. 원본 도면을 보거나 내려받아 확인하세요.</dd>
          <dt>엑셀·Zip 이 바로 안 받아집니다</dt><dd>뒤에서 만드는 중입니다. 진행률이 끝나면 [받기]가 나타납니다.</dd>
          <dt>화면이 예전 그대로입니다</dt><dd>브라우저가 옛 화면을 기억하고 있을 수 있습니다. <b>Ctrl + Shift + R</b> 로 새로 받으세요.</dd>
          <dt>로그인 화면으로 튕겼습니다</dt><dd>한동안 쓰지 않아 로그인이 풀린 것입니다. 다시 로그인하세요.</dd>
          <dt>실수로 지웠습니다</dt><dd>[TDB 관리]·[MDB 관리]의 보관함에서 [복구]합니다. 원래 폴더가 사라졌다면 그 폴더를 먼저 복구하세요. 완전 삭제한 것은 되살릴 수 없습니다.</dd>
          <dt>그 밖의 문제</dt><dd>[시스템 로그]에서 언제·누가·무엇을 했는지 확인한 뒤 관리자에게 알려 주세요.</dd>
        </dl>` },
    ],
  },
]

// ── 검색 ─────────────────────────────────────────────────────────────────
const keyword = ref('')
const strip = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const norm = (s: string) => s.toLowerCase()

const visible = computed(() => {
  const k = norm(keyword.value.trim())
  if (!k) return SECTIONS
  return SECTIONS
    .map((s) => {
      const hitTitle = norm(s.title).includes(k) || norm(s.lead ?? '').includes(k)
      const items = hitTitle ? s.items : s.items.filter((i) => norm(i.title + ' ' + strip(i.html)).includes(k))
      return { ...s, items }
    })
    .filter((s) => s.items.length)
})
const hitCount = computed(() => visible.value.reduce((n, s) => n + s.items.length, 0))

/** 찾은 말에 형광 표시 — 태그 안(속성)은 건드리지 않고 글자 부분만 */
function mark(html: string): string {
  const k = keyword.value.trim()
  if (!k) return html
  const re = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  return html.split(/(<[^>]+>)/).map((part) => (part.startsWith('<') ? part : part.replace(re, (m) => `<mark>${m}</mark>`))).join('')
}
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

// ── 목차 ─────────────────────────────────────────────────────────────────
const body = ref<HTMLElement | null>(null)
async function jump(id: string) {
  await nextTick()
  body.value?.querySelector(`#help-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
/** 본문 안 링크(#help-…)도 같은 방식으로 */
function onBodyClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a[href^="#help-"]')
  if (!a) return
  e.preventDefault()
  void jump(a.getAttribute('href')!.slice('#help-'.length))
}

const printPage = () => window.print()
const sectionNo = (id: string) => SECTIONS.findIndex((s) => s.id === id) + 1
</script>

<template>
  <main class="app-main help">
    <div class="page-head">
      <div>
        <h1 class="page-title">
          도움말<span class="page-title-sub">화면별 사용법과 업무 흐름 안내</span>
        </h1>
        <p class="page-desc">
          {{ session.me?.name }} 님이 쓸 수 있는 화면 {{ session.menu.length }}개
        </p>
      </div>
      <div class="page-actions no-print">
        <button type="button" @click="printPage">인쇄 · PDF로 저장</button>
      </div>
    </div>

    <div class="panel search no-print">
      <input v-model="keyword" type="search" class="search-input"
             placeholder="궁금한 말을 넣어 보세요 (예: 반출, 반려, 비밀번호, 보관, DWG)" />
      <span v-if="keyword.trim()" class="muted small">
        {{ hitCount ? `${hitCount}개 항목에서 찾았습니다` : '찾는 말이 들어 있는 항목이 없습니다' }}
      </span>
      <button v-if="keyword" class="btn btn-sm" type="button" @click="keyword = ''">검색 지우기</button>
    </div>

    <div class="layout">
      <nav class="panel toc no-print" aria-label="도움말 목차">
        <div class="toc-head">목차</div>
        <a v-for="s in SECTIONS" :key="s.id" href="#" class="toc-item"
           :class="{ dim: !visible.some((v) => v.id === s.id) }"
           @click.prevent="jump(s.id)">{{ sectionNo(s.id) }}. {{ s.title }}</a>
      </nav>

      <div ref="body" class="panel body" @click="onBodyClick">
        <section v-for="s in visible" :id="`help-${s.id}`" :key="s.id" class="sec">
          <h2>{{ sectionNo(s.id) }}. <span v-html="mark(escapeHtml(s.title))" /></h2>
          <p v-if="s.lead" class="lead" v-html="mark(escapeHtml(s.lead))" />
          <div v-for="i in s.items" :key="i.title" class="item">
            <h3 v-html="mark(escapeHtml(i.title))" />
            <div class="content" v-html="mark(i.html)" />
          </div>
        </section>
        <p v-if="!visible.length" class="pad muted">찾는 말이 들어 있는 항목이 없습니다. 다른 말로 찾아보세요.</p>
        <p class="pad muted small foot">이 도움말은 현재 화면 구성을 기준으로 작성되었습니다. 화면이 바뀌면 내용도 함께 고쳐집니다.</p>
      </div>
    </div>
  </main>
</template>

<style scoped>
.help { display: flex; flex-direction: column; gap: var(--gap); min-height: 0; }
.head { display: flex; align-items: baseline; gap: 10px; padding: 10px 12px; flex: 0 0 auto; }
.head h1 { font-size: var(--fs-md); margin: 0; font-weight: 600; }
.sub { font-size: var(--fs-sm); }
.small { font-size: var(--fs-sm); }
.search { display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex: 0 0 auto; }
.search-input { width: 420px; max-width: 100%; }
.layout { flex: 1; display: flex; gap: var(--gap); min-height: 0; }
.toc { width: 230px; flex: 0 0 230px; overflow: auto; padding: 8px 0; }
.toc-head { font-weight: 600; padding: 4px 14px 8px; border-bottom: 1px solid var(--border); margin-bottom: 4px; }
.toc-item { display: block; padding: 5px 14px; font-size: var(--fs-sm); color: inherit; text-decoration: none; }
.toc-item:hover { background: var(--accent-soft, var(--bg)); }
.toc-item.dim { opacity: .4; }
.body { flex: 1; overflow: auto; min-height: 0; min-width: 0; }
.sec { padding: 6px 20px 18px; }
.sec + .sec { border-top: 1px solid var(--border); }
h2 { font-size: var(--fs-lg); margin: 14px 0 6px; font-weight: 600; }
h3 { font-size: var(--fs-base, var(--fs)); margin: 16px 0 6px; }
.lead { margin: 0 0 4px; color: var(--text-muted); }
.content { line-height: 1.7; }
.content :deep(ul), .content :deep(ol) { margin: 6px 0; padding-left: 22px; }
.content :deep(dl) { margin: 6px 0; }
.content :deep(dt) { font-weight: 600; margin-top: 10px; }
.content :deep(dd) { margin: 2px 0 0 0; }
.content :deep(p) { margin: 6px 0; }
.content :deep(.note) {
  padding: 6px 10px; border-left: 3px solid var(--primary); background: var(--bg); font-size: var(--fs-sm);
}
.body :deep(mark) { background: #ffe58a; color: inherit; padding: 0 1px; }
.foot { border-top: 1px solid var(--border); margin-top: 0; }
.pad { padding: 12px 20px; }
@media (max-width: 900px) {
  .layout { flex-direction: column; }
  .toc { width: auto; flex: 0 0 auto; max-height: 180px; }
}
</style>

<style>
/* 인쇄 — 메뉴·상단바·목차·검색은 빼고 본문만 펼쳐서 낸다 */
@media print {
  .nav, .topbar, .no-print, .nav-backdrop { display: none !important; }
  .app-shell, .app-pane, .app-body, .app-main.help, .help .layout, .help .body {
    display: block !important; overflow: visible !important; height: auto !important;
  }
  .help .panel { border: 0 !important; box-shadow: none !important; }
  .help .sec { break-inside: avoid-page; }
}
</style>
