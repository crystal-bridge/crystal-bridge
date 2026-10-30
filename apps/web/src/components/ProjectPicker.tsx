import { useState } from 'react';
import type { Project } from '@crystal-bridge/protocol';

export interface ProjectPickerProps {
  /** The Kingdom's project folders, most recently used first. */
  projects: Project[];
  /** The working directory: a picked project's path, or whatever was typed. */
  value: string;
  onChange: (path: string) => void;
}

const MAX_SHOWN = 12;

/** A searchable list of the Kingdom's projects that still accepts any path typed in. */
export function ProjectPicker({ projects, value, onChange }: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);

  const query = value.trim().toLowerCase();
  const exact = projects.some((p) => p.path === value);
  const matches = (
    exact || !query
      ? projects
      : projects.filter((p) => p.name.toLowerCase().includes(query) || p.path.toLowerCase().includes(query))
  ).slice(0, MAX_SHOWN);
  const shown = open ? matches : [];

  function pick(project: Project) {
    onChange(project.path);
    setOpen(false);
    setHighlight(-1);
  }

  return (
    <div className="relative">
      <input
        aria-label="Project"
        role="combobox"
        aria-expanded={shown.length > 0}
        aria-autocomplete="list"
        placeholder={projects.length ? 'Pick a project or type a path' : 'Type a path'}
        value={value}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 100)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHighlight(-1);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setHighlight((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter' && open && highlight >= 0 && matches[highlight]) {
            e.preventDefault();
            pick(matches[highlight]!);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        className="cb-field w-full font-mono text-sm"
      />
      {shown.length > 0 && (
        <ul
          role="listbox"
          className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded border border-neutral-300 bg-white text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        >
          {shown.map((project, i) => (
            <li
              key={project.path}
              role="option"
              aria-selected={i === highlight}
              // mousedown would blur the input first; keep focus, then pick on click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(project)}
              className={`cursor-pointer px-2 py-1.5 ${i === highlight ? 'bg-blue-600 text-white' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'}`}
            >
              <span className="font-medium">{project.name}</span>
              <span className={`ml-2 font-mono text-xs ${i === highlight ? 'text-blue-100' : 'text-neutral-500'}`}>
                {project.path}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
