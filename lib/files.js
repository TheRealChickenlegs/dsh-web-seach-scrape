/**
 * Output handling: where a scrape lands, how a large body is bounded for the
 * model, and how filenames stay stable and collision-free.
 *
 * Rule of thumb for this plugin: return at most `maxInlineChars` of a page to a
 * model, and always write the complete body to disk when it is cut, so nothing
 * is lost and the model still gets a usable preview.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getService } from './credentials.js';
/** Session working directory from the execution context (structural probes). */
export function resolveCwd(exec) {
    const agent = exec?.agent;
    if (agent) {
        const candidates = [
            agent.cwd,
            agent.meta?.cwd,
            agent.session?.cwd,
            agent.session?.header?.cwd
        ];
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim() !== '')
                return candidate;
        }
    }
    return process.cwd();
}
/**
 * Resolve the session working directory through DSH's workingDirectory service,
 * with the structural probes as a fallback. Outputs must not land in the DSH
 * process directory when the session has its own workspace.
 */
export async function resolveSessionCwd(host, exec) {
    const agent = exec?.agent;
    const service = getService(host, 'workingDirectory');
    if (agent !== undefined && service?.ensure !== undefined) {
        try {
            const resolved = await service.ensure(agent, exec?.signal);
            if (typeof resolved === 'string' && resolved.trim() !== '')
                return resolved;
        }
        catch {
            /* fall through to the structural probes */
        }
    }
    return resolveCwd(exec);
}
/** Filesystem-safe component derived from arbitrary text. */
export function sanitizeComponent(value, maxLength = 60) {
    const cleaned = value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
    const trimmed = cleaned.slice(0, maxLength).replace(/[-.]+$/, '');
    return trimmed === '' ? 'untitled' : trimmed;
}
/** Timestamp used in generated file names. */
export function timestampSlug(date = new Date()) {
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    return (`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`);
}
/** A readable file stem for one URL: host + last path segment. */
export function slugForUrl(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./, '');
        const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
        const last = segments.length > 0 ? segments[segments.length - 1] : 'index';
        return sanitizeComponent(`${host}-${last}`, 72);
    }
    catch {
        return sanitizeComponent(url, 72);
    }
}
/** Choose a directory: the explicit target, the configured default, or the session cwd. */
export function resolveOutputDir(explicit, configured, cwd) {
    const chosen = explicit !== undefined && explicit.trim() !== '' ? explicit.trim() : configured;
    if (chosen === undefined || chosen.trim() === '')
        return cwd;
    const expanded = chosen === '~' ? process.env.HOME ?? chosen : chosen.startsWith('~/') ? path.join(process.env.HOME ?? '', chosen.slice(2)) : chosen;
    return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}
/** Create a path that does not exist yet (`-1`, `-2`, … suffixes). */
export async function uniquePath(target) {
    const extension = path.extname(target);
    const stem = target.slice(0, target.length - extension.length);
    for (let index = 0; index < 1000; index += 1) {
        const candidate = index === 0 ? target : `${stem}-${index}${extension}`;
        try {
            await fs.access(candidate);
        }
        catch {
            return candidate;
        }
    }
    return `${stem}-${Date.now()}${extension}`;
}
/** Write text, creating parent directories, never overwriting silently. */
export async function writeTextFile(directory, name, content) {
    await fs.mkdir(directory, { recursive: true });
    const target = await uniquePath(path.join(directory, name));
    await fs.writeFile(target, content, 'utf8');
    return target;
}
/** Write a JSON sidecar next to an output file. */
export async function writeMetadataFile(directory, name, value) {
    return writeTextFile(directory, name, `${JSON.stringify(value, null, 2)}\n`);
}
/**
 * Bound a body for model consumption: keep the head and the tail, mark the cut.
 * A tail is included because page conclusions, tables and footers are often the
 * part a model needs after skimming the opening.
 */
export function previewText(content, maxChars) {
    if (maxChars <= 0 || content.length <= maxChars)
        return { text: content, truncated: false };
    const head = Math.floor(maxChars * 0.75);
    const tail = maxChars - head;
    const omitted = content.length - maxChars;
    return {
        text: `${content.slice(0, head)}\n\n… [${omitted} characters omitted; the full content is in the saved file] …\n\n${content.slice(content.length - tail)}`,
        truncated: true
    };
}
/** Reject a URL that cannot be a scrape target, before spending a job on it. */
export function validateTargetUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        return { error: `"${value}" is not a valid URL` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: `"${value}" must use http or https` };
    }
    if (parsed.username !== '' || parsed.password !== '') {
        return { error: `"${value}" must not embed credentials` };
    }
    return { url: parsed.toString() };
}
