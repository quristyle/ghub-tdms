import { describe, expect, it } from 'vitest'
import type { CartFolder } from '@tdms/contracts'

interface CartFolderTreeNode extends CartFolder {
  depth: number
  children: CartFolderTreeNode[]
}

function buildFolderTree(items: CartFolder[]): CartFolderTreeNode[] {
  const map = new Map<number, CartFolderTreeNode>()
  for (const f of items) {
    map.set(f.id, { ...f, depth: 0, children: [] })
  }
  const roots: CartFolderTreeNode[] = []
  for (const f of items) {
    const node = map.get(f.id)!
    if (f.parentId !== null && map.has(f.parentId)) {
      map.get(f.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  function setDepth(nodes: CartFolderTreeNode[], depth: number) {
    for (const n of nodes) {
      n.depth = depth
      if (n.children.length) setDepth(n.children, depth + 1)
    }
  }
  setDepth(roots, 0)
  return roots
}

function isDescendantOf(candidateId: number, ancestorId: number, folders: CartFolder[]): boolean {
  if (candidateId === ancestorId) return true
  let curr = folders.find((f) => f.id === candidateId)
  while (curr && curr.parentId !== null) {
    const parentId: number = curr.parentId
    if (parentId === ancestorId) return true
    curr = folders.find((f) => f.id === parentId)
  }
  return false
}

function canDropOnFolder(
  draggedFolder: CartFolder | null,
  targetFolder: CartFolder,
  folders: CartFolder[],
): boolean {
  if (!draggedFolder) return false
  if (draggedFolder.id === targetFolder.id) return false
  if (draggedFolder.parentId === targetFolder.id) return false
  if (isDescendantOf(targetFolder.id, draggedFolder.id, folders)) return false
  return true
}

describe('Cart Folder Tree & Drag-and-Drop', () => {
  const folder1: CartFolder = { id: 1, parentId: null, name: '2026 울산공사', sortOrder: 1, docCount: 3, createdAt: '', updatedAt: '' }
  const folder2: CartFolder = { id: 2, parentId: 1, name: '배관도면', sortOrder: 1, docCount: 2, createdAt: '', updatedAt: '' }
  const folder3: CartFolder = { id: 3, parentId: 2, name: '1공구', sortOrder: 1, docCount: 5, createdAt: '', updatedAt: '' }
  const folder4: CartFolder = { id: 4, parentId: null, name: '전기도면', sortOrder: 2, docCount: 0, createdAt: '', updatedAt: '' }
  const sampleFolders: CartFolder[] = [folder1, folder2, folder3, folder4]

  it('평면 폴더 목록을 부모-자식 계층 트리로 변환하고 depth를 올바르게 계산한다', () => {
    const tree = buildFolderTree(sampleFolders)

    expect(tree).toHaveLength(2) // 루트 폴더 2개
    const root0 = tree[0]!
    expect(root0.id).toBe(1)
    expect(root0.depth).toBe(0)
    expect(root0.children).toHaveLength(1)

    const child = root0.children[0]!
    expect(child.id).toBe(2)
    expect(child.depth).toBe(1)
    expect(child.children).toHaveLength(1)

    const grandchild = child.children[0]!
    expect(grandchild.id).toBe(3)
    expect(grandchild.depth).toBe(2)
    expect(grandchild.children).toHaveLength(0)

    const root1 = tree[1]!
    expect(root1.id).toBe(4)
    expect(root1.depth).toBe(0)
  })

  it('드래그앤드롭 순환 참조 방지: 상위 폴더는 자신의 하위 폴더로 이동할 수 없다', () => {
    // id: 1을 하위 폴더 id: 2 또는 id: 3으로 드롭하는 것은 불가
    expect(canDropOnFolder(folder1, folder2, sampleFolders)).toBe(false)
    expect(canDropOnFolder(folder1, folder3, sampleFolders)).toBe(false)

    // 자기 자신으로 드롭 불가
    expect(canDropOnFolder(folder1, folder1, sampleFolders)).toBe(false)

    // 이미 속해있는 부모 폴더로 드롭 불가 (동일 위치)
    expect(canDropOnFolder(folder2, folder1, sampleFolders)).toBe(false)
  })

  it('유효한 드래그앤드롭: 다른 독립 폴더 하위로 이동은 허용된다', () => {
    // 배관도면(2)을 전기도면(4) 하위로 이동 가능
    expect(canDropOnFolder(folder2, folder4, sampleFolders)).toBe(true)

    // 1공구(3)를 전기도면(4) 하위로 이동 가능
    expect(canDropOnFolder(folder3, folder4, sampleFolders)).toBe(true)
  })
})
