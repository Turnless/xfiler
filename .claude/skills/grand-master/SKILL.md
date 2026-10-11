---
name: grand-master
description: The verified coding patterns for this project, covering how we fetch data, handle errors, name things, and where files go. Loaded every session through CLAUDE.md. Follow it before writing or changing any code.
---

# Grand-Master: How This Project Is Built

> **Status:** EMPTY. Run `/master-learn`, then `/master-review`, to fill it.
> **Last reviewed:** never
> **Only `/master-review` may edit this file.** Every other skill writes to `.claude/patterns/draft.md`.

---

## Rules for the AI (read first, every time)

1. **Look here before writing code.** Find the section that covers the task and follow it exactly. Copy the *shape* of the example and the golden file.
2. **This file wins.** If you think another approach is better, finish the task the way this file says, then mention your idea in one line. Don't use it unless the user says yes.
3. **No rule covers the task?** Find the closest existing file in the repo and copy its style. Then tell the user:
   *"There's no rule for X yet. I copied the style of `<file>`. Run `/master-learn` to lock it in."*
4. **Never silently add** a new library, top-level folder, or way of doing something that already has a rule.
5. **The user is learning to code.** When you explain something, use plain language and keep it short. Say *what* you did and *which rule* you followed (e.g. "followed FETCH-1").

---

## Rule format (how each rule below is written)

```
### FETCH-1: <one-line rule>
- **Do:** ...
- **Don't:** ...
- **Golden file:** path/to/the/best/real/example.ts
- **Why:** one plain-language sentence
- **Example:**
  <10–20 lines max>
```

Rule IDs use these prefixes: MAP, FETCH, ERR, LOAD, NAME, COMP, STATE, STYLE, TYPE, NEVER.

---

## 1. Project map: where things go (MAP)
_No verified rules yet._

## 2. Data fetching (FETCH)
_No verified rules yet._

## 3. Error handling (ERR)
_No verified rules yet._

## 4. Loading & empty states (LOAD)
_No verified rules yet._

## 5. Naming: files, folders, functions, variables (NAME)
_No verified rules yet._

## 6. Components (COMP)
_No verified rules yet._

## 7. State management (STATE)
_No verified rules yet._

## 8. Styling (STYLE)
_No verified rules yet._

## 9. Types & data shapes (TYPE)
_No verified rules yet._

## 10. Never do this (NEVER)
_No verified rules yet._
