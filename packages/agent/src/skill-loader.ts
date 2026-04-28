import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface Skill {
  name: string;
  content: string;
}

export class SkillLoader {
  constructor(private readonly skillsDir: string) {}

  async load(names: string[]): Promise<Skill[]> {
    const skills: Skill[] = [];
    for (const name of names) {
      const skillPath = path.join(this.skillsDir, name, "SKILL.md");
      try {
        const content = await readFile(skillPath, "utf-8");
        skills.push({ name, content });
      } catch {
        console.warn(`[skill-loader] skill not found: ${skillPath}`);
      }
    }
    return skills;
  }

  async loadAll(): Promise<Skill[]> {
    try {
      const entries = await readdir(this.skillsDir, { withFileTypes: true });
      const names = entries.filter(e => e.isDirectory()).map(e => e.name);
      return this.load(names);
    } catch {
      return [];
    }
  }
}
