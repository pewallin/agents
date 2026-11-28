import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_ACTIONS, APP_HANDLERS } from "./bridge";
import { editFor, followAnswerEdits, followOwnThread, OWN_THREAD_POLL_MS, pageOptions, proposalKey, roundDuration, showsEdits, shownProposal, useAnswerEdits, useOwnThread, workLine } from "./thread-page";

describe("a thread's own view (Projects and Threads, R1, P5)", () => {
  it("is the thread page with presentation=thread, and shows terminal questions with questions=inline", () => {
    expect(pageOptions("?agents-next=acp-view&view=app&questions=inline&presentation=thread")).toEqual({ threadPresentation: true, inlineQuestions: true });
    // Show Session drops presentation=thread: the session as any pane has it, its questions still inline.
    expect(pageOptions("?agents-next=acp-view&view=app&questions=inline")).toEqual({ threadPresentation: false, inlineQuestions: true });
    expect(pageOptions("?agents-next=acp-view&view=app")).toEqual({ threadPresentation: false, inlineQuestions: false });
  });

  it("answers a terminal question through the app's Answer in terminal, and has no copy of a thread beside it", () => {
    expect(APP_ACTIONS.answerInTerminal).toBe("agents-next-action://back-to-terminal?question=1&answer=1");
    expect("threadReply" in APP_HANDLERS).toBe(false);
    expect("closeTab" in APP_ACTIONS).toBe(false);
  });
});

describe("a thread's work line (P9)", () => {
  const start = Date.parse("2026-11-27T10:00:00.000Z");

  it("says how long it works and on what", () => {
    expect(workLine({ startedAt: start }, true, start + 125_000, "writing the TEST stage")).toBe("Working 2m · writing the TEST stage");
    expect(workLine({ startedAt: start }, true, start + 4_000)).toBe("Working 4s");
    expect(workLine({}, true, start)).toBe("Working");
  });

  it("says how long it worked once the turn is over", () => {
    expect(workLine({ startedAt: start, endedAt: start + 125_000 }, false, start + 200_000)).toBe("Worked 2m");
    expect(workLine({ startedAt: start, endedAt: start + 300 }, false, start)).toBe("Worked");
    // A turn replayed from the session's history has no times: no line.
    expect(workLine({}, false, start)).toBeNull();
  });

  it("rounds a turn's length to what a glance needs", () => {
    expect(roundDuration(45_000)).toBe("45s");
    expect(roundDuration(150_000)).toBe("3m");
    expect(roundDuration(65 * 60_000)).toBe("1h 5m");
    expect(roundDuration(120 * 60_000)).toBe("2h");
  });
});

describe("a thread page's close card (P4, P8)", () => {
  afterEach(() => {
    vi.useRealTimers();
    useOwnThread.setState({ thread: null, settled: null });
  });

  it("shows the coordinator's proposal until the user settles that one", () => {
    const proposed = { why: "Klar och mergad", at: "2026-11-27T12:00:00.000Z" };
    const thread = { task: "fix", program: "/p", proposedClose: proposed };
    expect(shownProposal(thread, null)).toEqual(proposed);
    expect(shownProposal(thread, proposalKey(proposed))).toBeNull();
    // A new proposal after that one shows again.
    expect(shownProposal({ ...thread, proposedClose: { why: "Inte längre önskad", at: "2026-11-29T12:00:00.000Z", as: "dropped" } }, proposalKey(proposed))).toMatchObject({ as: "dropped" });
    expect(shownProposal({ task: "fix", program: "/p" }, null)).toBeNull();
    expect(shownProposal(null, null)).toBeNull();
  });

  it("follows what its host says of the thread", async () => {
    vi.useFakeTimers();
    let answer: { thread: { task: string; program: string; title?: string } | null } = { thread: { task: "fix", program: "/p", title: "Fixa inloggningen" } };
    const read = vi.fn(async () => answer);
    const stop = followOwnThread(read);
    await vi.advanceTimersByTimeAsync(0);
    expect(useOwnThread.getState().thread).toMatchObject({ title: "Fixa inloggningen" });
    answer = { thread: null };
    await vi.advanceTimersByTimeAsync(OWN_THREAD_POLL_MS);
    expect(useOwnThread.getState().thread).toBeNull();
    stop();
    const calls = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(OWN_THREAD_POLL_MS * 3);
    expect(read.mock.calls.length).toBe(calls);
  });
});

describe("an answer its agent edited", () => {
  afterEach(() => {
    vi.useRealTimers();
    useAnswerEdits.setState({ edits: [], role: null });
  });

  it("is found by the text the agent gave, however the view joins it", () => {
    const edits = [
      { original: "auth-fix är klar.", text: "auth-fix är klar, men CI är röd.", at: "2026-11-28T11:00:00.000Z" },
      { original: "Klart: steget är skrivet.\nPR:en är uppe och väntar på granskning av teamet.", text: "Klart.", at: "2026-11-28T11:05:00.000Z" },
    ];
    expect(editFor("auth-fix är klar.", edits)?.text).toBe("auth-fix är klar, men CI är röd.");
    expect(editFor("  auth-fix   är klar. ", edits)?.text).toBe("auth-fix är klar, men CI är röd.");
    expect(editFor("Klart: steget är skrivet. PR:en är uppe och väntar på granskning av teamet.", edits)?.text).toBe("Klart.");
    expect(editFor("auth-fix", edits)).toBeUndefined();
    expect(editFor("", edits)).toBeUndefined();
  });

  it("shows on a thread page and in a coordinator's conversation, never in a session", () => {
    expect(showsEdits(true, "worker")).toBe(true);
    expect(showsEdits(false, "coordinator")).toBe(true);
    expect(showsEdits(false, "worker")).toBe(false);
    expect(showsEdits(false, null)).toBe(false);
  });

  it("is followed while the page is seen, changes the page only when an edit changed, and stops for no project's pane", async () => {
    vi.useFakeTimers();
    let answer: { follows?: boolean; role?: string | null; edits?: Array<{ original: string; text: string; at: string }> } = { follows: true, role: "worker", edits: [{ original: "a", text: "b", at: "x" }] };
    const read = vi.fn(async () => answer);
    let changes = 0;
    const unsubscribe = useAnswerEdits.subscribe(() => { changes += 1; });
    const stop = followAnswerEdits(read);
    await vi.advanceTimersByTimeAsync(0);
    expect(useAnswerEdits.getState()).toMatchObject({ role: "worker", edits: [{ text: "b" }] });
    await vi.advanceTimersByTimeAsync(OWN_THREAD_POLL_MS * 2);
    expect(changes).toBe(1);
    answer = { follows: false };
    await vi.advanceTimersByTimeAsync(OWN_THREAD_POLL_MS);
    const calls = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(OWN_THREAD_POLL_MS * 3);
    expect(read.mock.calls.length).toBe(calls);
    stop();
    unsubscribe();
  });
});
