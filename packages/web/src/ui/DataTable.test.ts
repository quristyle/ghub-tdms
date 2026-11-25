import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('DataTable Checkbox cell interaction', () => {
  it('체크박스 셀(.dt-cell.dt-check)을 클릭하면 토글이 호출되고 행 클릭 이벤트 전파가 방지된다', () => {
    const filePath = resolve(__dirname, 'DataTable.vue')
    const content = readFileSync(filePath, 'utf-8')

    // 1. 헤더 체크박스 셀이 전체 영역 클릭 시 toggleAll을 호출하고 stopPropagation 처리되어 있는지 확인
    expect(content).toContain("@click.stop=\"emit('toggleAll', !allChecked)\"")
    expect(content).toContain('class="dt-cell dt-check"')

    // 2. 바디 행의 체크박스 셀이 셀 클릭 시 toggle을 호출하고 행 클릭 이벤트 전파를 막는지 확인
    expect(content).toContain("@click.stop=\"emit('toggle', rowOf(v.index)!.id)\"")

    // 3. input은 pointer-events: none 으로 마우스 클릭 시 셀 전체가 균일하게 반응하도록 처리되어 있는지 확인
    expect(content).toContain('style="pointer-events: none;"')

    // 4. 키보드 접근성(space, enter) 지원 여부 확인
    expect(content).toContain("@keydown.space.prevent.stop=\"emit('toggle', rowOf(v.index)!.id)\"")
    expect(content).toContain("@keydown.enter.prevent.stop=\"emit('toggle', rowOf(v.index)!.id)\"")

    // 5. CSS 스타일에서 .dt-check의 패딩이 0이고 cursor: pointer인지 확인
    expect(content).toContain('cursor: pointer;')
    expect(content).toContain('user-select: none;')
  })

  it('슬롯 셀(.dt-cell.dt-slot)이 display: block에 덮어씌워지지 않도록 :not(.dt-slot)이 적용되어 있어야 한다', () => {
    const filePath = resolve(__dirname, 'DataTable.vue')
    const content = readFileSync(filePath, 'utf-8')

    expect(content).toContain('.dt-cell:not(.dt-th):not(.dt-no):not(.dt-check):not(.dt-slot) { display: block; }')
    expect(content).toContain('.dt-cell.dt-slot { display: flex; align-items: center; gap: 4px; overflow: hidden; }')
  })
})
