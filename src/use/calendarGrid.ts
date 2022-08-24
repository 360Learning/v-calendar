import {
  Ref,
  ComputedRef,
  PropType,
  ref,
  computed,
  provide,
  inject,
  watch,
  nextTick,
} from 'vue';
import {
  CalendarProps,
  CalendarContext,
  props as calendarProps,
  emits as calendarEmits,
  useCalendar,
} from './calendar';
import { CalendarDay, CalendarWeek, Page } from '../utils/locale';
import { createGuid, on } from '../utils/helpers';
import {
  EventConfig,
  Event,
  createEvent as _createEvent,
} from '../utils/calendar/event';
import { Cell, createDayCell } from '../utils/calendar/cell';
import CalendarCellPopover from '../components/CalendarCellPopover/CalendarCellPopover.vue';
import { roundDate, MS_PER_HOUR } from '../utils/dates';
import DateInfo from '../utils/dateInfo';
import { pick } from '../utils/_';

type GridState =
  | 'NORMAL'
  | 'CREATE_MONITOR'
  | 'DRAG_MONITOR'
  | 'RESIZE_MONITOR';

export type GridStateEvent =
  | 'GRID_CURSOR_DOWN'
  | 'GRID_CURSOR_DOWN_SHIFT'
  | 'GRID_CURSOR_MOVE'
  | 'GRID_CURSOR_MOVE_SHIFT'
  | 'GRID_CURSOR_UP'
  | 'GRID_CURSOR_UP_SHIFT'
  | 'EVENT_CURSOR_DOWN'
  | 'EVENT_CURSOR_DOWN_SHIFT'
  | 'EVENT_CURSOR_MOVE'
  | 'EVENT_CURSOR_MOVE_SHIFT'
  | 'EVENT_RESIZE_START_CURSOR_DOWN'
  | 'EVENT_RESIZE_START_CURSOR_DOWN_SHIFT'
  | 'EVENT_RESIZE_END_CURSOR_DOWN'
  | 'EVENT_RESIZE_END_CURSOR_DOWN_SHIFT'
  | 'ESCAPE';

export interface Point {
  x: number;
  y: number;
}

export interface DragOffset {
  weekdays: number;
  weeks: number;
  ms: number;
}

export interface ResizeOffset {
  weekdays: number;
  weeks: number;
  ms: number;
}

interface DragOriginState {
  position: number;
  date: Date;
  day: CalendarDay;
  event: Event;
  eventSelected: boolean;
  ms: number;
}

interface ResizeOriginState {
  position: number;
  day: CalendarDay;
  event: Event;
  isWeekly: boolean;
  isStart: boolean;
  isNew: boolean;
  ms: number;
}

interface CreateOriginState {
  position: number;
  date: Date;
  day: CalendarDay;
  isWeekly: boolean;
}

export interface CalendarGridProps extends CalendarProps {
  events: EventConfig[];
}

export const props = {
  ...calendarProps,
  events: {
    type: Object as PropType<EventConfig[]>,
  },
};

// #region Messages

type MessageType =
  | 'event-create-begin'
  | 'event-create-end'
  | 'event-resize-begin'
  | 'event-resize-update'
  | 'event-resize-end'
  | 'event-move-begin'
  | 'event-move-update'
  | 'event-move-end'
  | 'event-remove';

class Messages {
  static _emit: Function;

  static EventCreateBegin(event: EventConfig) {
    return new CancellableEventMessage(this._emit, 'event-create-begin', event);
  }

  static EventCreateEnd(event: Event) {
    return new EventMessage(this._emit, 'event-create-end', event);
  }

  static EventResizeBegin(event: Event) {
    return new CancellableEventMessage(this._emit, 'event-resize-begin', event);
  }

  static EventResizeUpdate(event: Event, offset: ResizeOffset) {
    return new EventResizeMessage(
      this._emit,
      'event-resize-update',
      event,
      offset,
    );
  }

  static EventResizeEnd(event: Event) {
    return new EventMessage(this._emit, 'event-resize-end', event);
  }

  static EventMoveBegin(event: Event) {
    return new CancellableEventMessage(this._emit, 'event-move-begin', event);
  }

  static EventMoveUpdate(event: Event, offset: DragOffset) {
    return new EventMoveMessage(this._emit, 'event-move-update', event, offset);
  }

  static EventMoveEnd(event: Event) {
    return new EventMessage(this._emit, 'event-move-end', event);
  }

  static EventRemove(event: Event) {
    return new CancellableEventMessage(this._emit, 'event-remove', event);
  }
}

class BaseMessage {
  private emit: Function;
  type: MessageType;

  constructor(emit: Function, type: MessageType) {
    this.emit = emit;
    this.type = type;
  }

  send() {
    this.emit(this.type, this);
    return this;
  }

  async sendAsync() {
    this.emit(this.type, this);
    await nextTick();
    return this;
  }
}

class EventMessage<T extends Event | EventConfig> extends BaseMessage {
  event: T;
  constructor(emit: Function, type: MessageType, event: T) {
    super(emit, type);
    this.event = event;
  }
}

class CancellableEventMessage<
  T extends Event | EventConfig,
> extends EventMessage<T> {
  cancel = false;
}

class EventResizeMessage extends CancellableEventMessage<Event> {
  offset?: ResizeOffset;

  constructor(
    emit: Function,
    type: MessageType,
    event: Event,
    offset?: ResizeOffset,
  ) {
    super(emit, type, event);
    this.offset = offset;
  }
}

class EventMoveMessage extends CancellableEventMessage<Event> {
  offset?: DragOffset;

  constructor(
    emit: Function,
    type: MessageType,
    event: Event,
    offset?: ResizeOffset,
  ) {
    super(emit, type, event);
    this.offset = offset;
  }
}

// #endregion Messages

export const emits = [
  ...calendarEmits,
  'day-header-click',
  'event-create-begin',
  'event-create-end',
  'event-resize-begin',
  'event-resize-update',
  'event-resize-end',
  'event-move-begin',
  'event-move-update',
  'event-move-end',
  'event-remove',
];

const SNAP_MINUTES = 15;
const PIXELS_PER_HOUR = 50;
const contextKey = '__vc_grid_context__';

export function useCalendarGrid(
  props: CalendarGridProps,
  ctx: any,
): CalendarGridContext {
  const { emit } = ctx;
  const calendar = useCalendar(props, ctx);
  const cellPopoverRef = ref<typeof CalendarCellPopover>();
  const dailyGridRef = ref<HTMLElement | null>(null);
  const weeklyGridRef = ref<HTMLElement | null>(null);
  let activeGridRef = ref<HTMLElement | null>(null);
  Messages._emit = emit;

  const {
    view,
    isDaily,
    isMonthly,
    pages,
    firstPage,
    locale,
    move,
    onDayFocusin,
  } = calendar;

  const page = computed<Page>(() => pages.value[0]);
  const days = computed(() => page.value.viewDays);
  const weeks = computed(() => page.value.viewWeeks);
  const dayColumns = computed(() => {
    if (isDaily.value) return 1;
    return weeks.value[0].days.length;
  });
  const dayRows = computed(() => {
    if (isMonthly.value) return weeks.value.length;
    return 1;
  });

  const snapMinutes = ref(SNAP_MINUTES);
  const snapMs = computed(() => snapMinutes.value * 60 * 10000);
  const pixelsPerHour = ref(PIXELS_PER_HOUR);

  const state = ref<GridState>('NORMAL');
  const fill = ref('light');

  const eventsMap = ref<Record<any, Event>>({});
  const events = computed(() => Object.values(eventsMap.value));
  const weekEvents: Ref<Event[][]> = ref([]);
  const dayCells: Ref<Cell[][]> = ref([]);
  const detailEvent = ref<Event | null>(null);

  const createOrigin = ref<CreateOriginState | null>(null);

  const resizing = ref(false);
  let resizeOrigin: ResizeOriginState | null = null;

  const dragging = ref(false);
  let dragOrigin: DragOriginState | null = null;

  const isTouch = ref(false);

  const active = computed(() => resizing.value || dragging.value);

  const selectedEvents = computed(() => events.value.filter(e => e.selected));

  const selectedEventsCount = computed(() => selectedEvents.value.length);

  const hasSelectedEvents = computed(() => selectedEventsCount.value > 0);

  const gridStyle = computed(() => {
    return {
      height: `${24 * pixelsPerHour.value}px`,
    };
  });

  function getEventContext() {
    return {
      locale,
      days,
      dayRows,
      dayColumns,
      isDaily,
      isMonthly,
      snapMinutes: snapMinutes.value,
      pixelsPerHour: pixelsPerHour.value,
    };
  }

  // #region Event details

  function showCellPopover(event: Event) {
    setTimeout(() => {
      if (isDaily.value || !cellPopoverRef.value) return;
      cellPopoverRef.value.show(event);
    }, 10);
  }

  function updateCellPopover(event: Event) {
    if (!cellPopoverRef.value) return;
    cellPopoverRef.value.update(event);
  }

  function hideCellPopover() {
    if (isDaily.value || !cellPopoverRef.value) return;
    cellPopoverRef.value.hide();
  }

  function popoverVisible() {
    return !!cellPopoverRef.value && cellPopoverRef.value.isVisible();
  }

  // #endregion Cell details

  // #region Util

  function createEventFromExisting(config: EventConfig, dateInfo?: DateInfo) {
    const pickProps = ['selected'];
    const existingEvent = pick(
      events.value.find(e => e.key === config.key),
      pickProps,
    );
    return _createEvent(
      {
        ...existingEvent,
        ...config,
        dateInfo,
      },
      getEventContext(),
    );
  }

  function createNewEvent(date: Date, isWeekly: boolean) {
    const msg = Messages.EventCreateBegin({
      key: createGuid(),
      start: date,
      end: date,
      isAllDay: isWeekly,
    }).send();
    if (msg.cancel || !msg.event) return;
    const event = _createEvent(msg.event, getEventContext());
    eventsMap.value[event.key] = event;
    refreshEventCells();
    return event;
  }

  function removeEvent(event: Event) {
    const msg = Messages.EventRemove(event).send();
    if (msg.cancel) return;
    delete eventsMap.value[event.key];
    refreshEventCells();
    hideCellPopover();
  }

  function sortEvents(e: Event[][]) {
    for (let i = 0; i < e.length; i++) {
      e[i] = e[i].sort((a, b) => a.compareTo(b));
    }
    return e;
  }

  function sortCells(e: Cell[][]) {
    for (let i = 0; i < e.length; i++) {
      e[i] = e[i].sort((a, b) => a.event.compareTo(b.event));
    }
    return e;
  }

  function getEventsFromProps() {
    return props.events.reduce((map, config) => {
      map[config.key] = map[config.key] || createEventFromExisting(config);
      return map;
    }, {} as Record<any, Event>);
  }

  function groupEvents(map: Record<any, Event>, evts: Event[]) {
    return days.value.map(day => {
      const group: { day: CalendarDay; events: Event[] } = { day, events: [] };
      evts.forEach(evt => {
        if (evt.dateInfo.intersectsDay(day) && map[evt.key]) {
          group.events.push(map[evt.key]);
        }
      });
      return group;
    });
  }

  function doRefreshEventCells() {
    const rWeekEvents: Set<Event>[] = weeks.value.map(() => new Set());
    const rDayCells: Cell[][] = days.value.map(() => []);

    const groupedEvents = groupEvents(eventsMap.value, events.value);
    groupedEvents.forEach(({ day, events: evts }, dayIdx) => {
      evts.forEach(event => {
        if (isMonthly.value || event.isWeekly) {
          const wIdx = day.weekPosition - weeks.value[0].weekPosition;
          rWeekEvents[wIdx].add(event);
        } else {
          rDayCells[dayIdx].push(
            createDayCell(event, { day, isMonthly, isDaily, pixelsPerHour }),
          );
        }
      });
    });
    weekEvents.value = sortEvents(rWeekEvents.map(wc => [...wc]));
    dayCells.value = sortCells(rDayCells);
  }

  function refreshEventCells() {
    requestAnimationFrame(() => doRefreshEventCells());
  }

  function getMsFromPosition(position: number) {
    const hours = Math.max(Math.min(position / pixelsPerHour.value, 24), 0);
    return hours * MS_PER_HOUR;
  }

  function getDateFromPosition(
    position: number,
    day: CalendarDay,
    offsetMs = 0,
    snapMs = 0,
  ) {
    const startTime = day.range.start.getTime();
    const ms = getMsFromPosition(position);
    const date = roundDate(startTime + ms + offsetMs, snapMs);
    return date;
  }

  const getPositionFromMouseEvent = (
    gridEl: HTMLElement,
    event: MouseEvent,
  ): Point => {
    const rect = gridEl.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return { x, y };
  };

  const getPositionFromTouchEvent = (
    gridEl: HTMLElement,
    event: TouchEvent,
  ): Point => {
    const rect = gridEl.getBoundingClientRect();
    const touch = event.targetTouches[0] || event.changedTouches[0];
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;
    return { x, y };
  };

  const getPositionFromUIEvent = (
    gridEl: HTMLElement,
    event: UIEvent,
  ): Point => {
    if (event.type.startsWith('touch'))
      return getPositionFromTouchEvent(gridEl, event as TouchEvent);
    return getPositionFromMouseEvent(gridEl, event as MouseEvent);
  };

  const getDayFromPosition = (el: HTMLElement, { x, y }: any) => {
    if (!el) return days.value[0];
    const rect = el.getBoundingClientRect();
    const dayWidth = rect.width / dayColumns.value;
    const dayHeight = rect.height / dayRows.value;
    const xNorm = Math.max(Math.min(x, rect.width), 0);
    const yNorm = Math.max(Math.min(y, rect.height), 0);
    const xIdx = Math.min(Math.floor(xNorm / dayWidth), dayColumns.value - 1);
    const yIdx = Math.min(Math.floor(yNorm / dayHeight), dayRows.value - 1);
    const idx = xIdx + yIdx * dayColumns.value;
    return days.value[idx];
  };

  // #endregion Util

  // #region Cell Operations

  function forSelectedEvents(fn: (event: Event) => void) {
    selectedEvents.value.forEach(e => fn(e));
  }

  function deselectAllEvents() {
    forSelectedEvents(cell => (cell.selected = false));
  }

  // #endregion Cell Operations

  // #region Resizing

  function startResizingEvents(
    position: number,
    day: CalendarDay,
    event: Event,
    isStart: boolean,
    isNew: boolean,
  ) {
    if (active.value) return;
    resizing.value = true;
    event.selected = true;
    const isWeekly = activeGridRef === weeklyGridRef;
    const ms = getMsFromPosition(position);
    resizeOrigin = {
      position,
      day,
      event,
      isWeekly,
      isStart,
      isNew,
      ms,
    };
    forSelectedEvents(event => {
      const msg = Messages.EventResizeBegin(event).send();
      if (msg.cancel) return;
      event.startResize(day, isStart);
    });
  }

  function updateResizingEvents(position: number, day: CalendarDay) {
    if (!resizing.value || !resizeOrigin) return;
    const offset: ResizeOffset = { weeks: 0, weekdays: 0, ms: 0 };
    if (resizeOrigin.isWeekly) {
      offset.weeks = day.weekPosition - resizeOrigin.day.weekPosition;
      offset.weekdays = day.weekdayPosition - resizeOrigin.day.weekdayPosition;
    } else {
      offset.ms = getMsFromPosition(position) - resizeOrigin.ms;
    }
    forSelectedEvents(event => {
      const msg = Messages.EventResizeUpdate(event, offset).send();
      if (msg.cancel) return;
      event.updateResize(offset);
    });
    refreshEventCells();
  }

  function stopResizingEvents() {
    if (!resizing.value || !resizeOrigin) return;
    forSelectedEvents(event => {
      Messages.EventResizeEnd(event);
      if (resizeOrigin!.isNew && event === resizeOrigin!.event) {
        Messages.EventCreateEnd(event);
        showCellPopover(event);
      }
      event.stopResize();
    });
    resizing.value = false;
    resizeOrigin = null;
  }

  // #endregion Resizing

  // #region Dragging

  function startDraggingEvents(
    position: number,
    day: CalendarDay,
    event: Event,
  ) {
    if (active.value) return;
    dragging.value = true;
    const date = getDateFromPosition(position, day, 0, 0);
    const eventSelected = event.selected;
    event.selected = true;
    const ms = getMsFromPosition(position);
    dragOrigin = {
      position,
      date,
      day,
      event,
      eventSelected,
      ms,
    };
    selectedEvents.value.forEach(event => {
      const msg = Messages.EventMoveBegin(event).send();
      if (msg.cancel) return;
      event.startDrag(day);
    });
  }

  function updateDraggingEvents(position: number, day: CalendarDay) {
    if (!dragging.value || !dragOrigin) return;
    const offset = {
      weeks: day.weekPosition - dragOrigin.day.weekPosition,
      weekdays: day.weekdayPosition - dragOrigin.day.weekdayPosition,
      ms: getMsFromPosition(position) - dragOrigin.ms,
    };
    forSelectedEvents(event => {
      const msg = Messages.EventMoveUpdate(event, offset).send();
      if (msg.cancel) return;
      event.updateDrag(offset);
    });
    refreshEventCells();
  }

  function stopDraggingEvents() {
    if (!dragging.value || !dragOrigin) return;
    dragging.value = false;
    dragOrigin = null;
    forSelectedEvents(event => {
      Messages.EventMoveEnd(event).send();
      event.stopDrag();
    });
  }

  // #endregion Dragging

  // #region Watchers

  watch(
    [firstPage],
    () => {
      refreshEventCells();
    },
    {
      immediate: true,
    },
  );

  function refreshEventsFromProps() {
    eventsMap.value = getEventsFromProps();
    refreshEventCells();
  }

  watch(
    () => props.events,
    () => {
      refreshEventsFromProps();
    },
    {
      deep: true,
    },
  );

  watch([view], () => {
    deselectAllEvents();
  });

  // #endregion Watchers

  // #region State management

  function handleNormalEvent(
    gse: GridStateEvent,
    day: CalendarDay,
    position: number,
    evt: Event | undefined,
  ) {
    switch (gse) {
      case 'GRID_CURSOR_DOWN':
      case 'GRID_CURSOR_DOWN_SHIFT': {
        createOrigin.value = {
          isWeekly: activeGridRef === weeklyGridRef,
          date: getDateFromPosition(position, day),
          position,
          day,
        };
        state.value = 'CREATE_MONITOR';
        break;
      }
      case 'EVENT_CURSOR_DOWN': {
        if (!evt) return;
        if (!evt.selected) deselectAllEvents();
        startDraggingEvents(position, day, evt);
        state.value = 'DRAG_MONITOR';
        break;
      }
      case 'EVENT_CURSOR_DOWN_SHIFT': {
        if (!evt) return;
        startDraggingEvents(position, day, evt);
        state.value = 'DRAG_MONITOR';
        break;
      }
      case 'EVENT_RESIZE_START_CURSOR_DOWN': {
        if (!evt) return;
        if (!evt.selected) deselectAllEvents();
        startResizingEvents(position, day, evt, true, false);
        state.value = 'RESIZE_MONITOR';
        break;
      }
      case 'EVENT_RESIZE_START_CURSOR_DOWN_SHIFT': {
        if (!evt) return;
        startResizingEvents(position, day, evt, true, false);
        state.value = 'RESIZE_MONITOR';
        break;
      }
      case 'EVENT_RESIZE_END_CURSOR_DOWN': {
        if (!evt) return;
        if (!evt.selected) deselectAllEvents();
        startResizingEvents(position, day, evt, false, false);
        state.value = 'RESIZE_MONITOR';
        break;
      }
      case 'EVENT_RESIZE_END_CURSOR_DOWN_SHIFT': {
        if (!evt) return;
        startResizingEvents(position, day, evt, false, false);
        state.value = 'RESIZE_MONITOR';
        break;
      }
    }
  }

  function handleCreateMonitorEvent(gse: GridStateEvent, day: CalendarDay) {
    if (!createOrigin.value) return;

    switch (gse) {
      case 'ESCAPE': {
        deselectAllEvents();
        break;
      }
      case 'GRID_CURSOR_UP':
      case 'GRID_CURSOR_UP_SHIFT': {
        deselectAllEvents();
        if (!popoverVisible()) {
          const { position, isWeekly } = createOrigin.value;
          const date = getDateFromPosition(position, day);
          const evt = createNewEvent(date, isWeekly);
          if (evt) {
            evt.selected = true;
            emit('did-create-event', evt);
            showCellPopover(evt);
          }
        }
        state.value = 'NORMAL';
        break;
      }
      case 'EVENT_CURSOR_MOVE':
      case 'EVENT_CURSOR_MOVE_SHIFT':
      case 'GRID_CURSOR_MOVE':
      case 'GRID_CURSOR_MOVE_SHIFT': {
        // if (isTouch.value || isMonthly.value) {
        // if (isTouch.value) {
        //   state.value = 'NORMAL';
        //   return;
        // }
        deselectAllEvents();
        const { position, isWeekly } = createOrigin.value;
        const date = getDateFromPosition(position, day);
        const evt = createNewEvent(date, isWeekly);
        if (evt) {
          startResizingEvents(position, day, evt, false, true);
          updateResizingEvents(position, day);
          state.value = 'RESIZE_MONITOR';
        }
        break;
      }
    }
  }

  function handleResizeMonitorEvent(
    event: GridStateEvent,
    position: number,
    day: CalendarDay,
  ) {
    if (!resizeOrigin) return;
    switch (event) {
      case 'EVENT_CURSOR_MOVE':
      case 'EVENT_CURSOR_MOVE_SHIFT':
      case 'GRID_CURSOR_MOVE':
      case 'GRID_CURSOR_MOVE_SHIFT': {
        updateResizingEvents(position, day);
        if (!resizeOrigin.isNew) {
          updateCellPopover(resizeOrigin.event);
        }
        break;
      }
      case 'GRID_CURSOR_UP': {
        if (position === resizeOrigin.position) {
          deselectAllEvents();
          resizeOrigin.event.selected = true;
        }
        stopResizingEvents();
        state.value = 'NORMAL';
        break;
      }
      case 'GRID_CURSOR_UP_SHIFT': {
        stopResizingEvents();
        state.value = 'NORMAL';
        break;
      }
    }
  }

  function handleDragMonitorEvent(
    event: GridStateEvent,
    day: CalendarDay,
    position: number,
  ) {
    if (!dragOrigin) return;
    switch (event) {
      case 'GRID_CURSOR_MOVE':
      case 'GRID_CURSOR_MOVE_SHIFT': {
        updateDraggingEvents(position, day);
        updateCellPopover(dragOrigin.event);
        break;
      }
      case 'GRID_CURSOR_UP': {
        const origin = dragOrigin;
        stopDraggingEvents();
        if (position === origin.position) {
          deselectAllEvents();
          origin.event.selected = true;
          showCellPopover(origin.event);
        }
        state.value = 'NORMAL';
        break;
      }
      case 'GRID_CURSOR_UP_SHIFT': {
        stopDraggingEvents();
        state.value = 'NORMAL';
        break;
      }
    }
  }

  function updateState(
    gse: GridStateEvent,
    day: CalendarDay,
    position: number,
    evt: Event | undefined = undefined,
  ) {
    switch (state.value) {
      case 'NORMAL': {
        handleNormalEvent(gse, day, position, evt);
        break;
      }
      case 'CREATE_MONITOR': {
        handleCreateMonitorEvent(gse, day);
        break;
      }
      case 'RESIZE_MONITOR': {
        handleResizeMonitorEvent(gse, position, day);
        break;
      }
      case 'DRAG_MONITOR': {
        handleDragMonitorEvent(gse, day, position);
        break;
      }
    }
  }

  const setActiveGrid = (event: MouseEvent | TouchEvent) => {
    activeGridRef =
      [dailyGridRef, weeklyGridRef].find(
        ref => ref.value && ref.value.contains(event.currentTarget as Node),
      ) || ref(null);
  };

  const handleEvent = (
    stateEvent: GridStateEvent,
    event: MouseEvent | TouchEvent | KeyboardEvent,
    evt: Event | undefined = undefined,
  ) => {
    if (!activeGridRef.value) return;
    if (event.type.startsWith('touch')) {
      isTouch.value = true;
    } else if (isTouch.value) {
      return;
    }
    const eventName = (
      event.shiftKey ? `${stateEvent}_SHIFT` : stateEvent
    ) as GridStateEvent;
    const position = getPositionFromUIEvent(activeGridRef.value, event);
    const day = getDayFromPosition(activeGridRef.value, position);
    updateState(eventName, day, position.y, evt);
    if (stateEvent === 'GRID_CURSOR_DOWN') {
      onDayFocusin(day, null);
    }
  };

  const startMonitoringGridMove = () => {
    const offMove = on(window, 'mousemove', event => {
      handleEvent('GRID_CURSOR_MOVE', event as MouseEvent);
    });
    const offUp = on(window, 'mouseup', event => {
      handleEvent('GRID_CURSOR_UP', event as MouseEvent);
      offMove();
      offUp();
    });
  };

  // #endregion State management

  refreshEventsFromProps();

  const context = {
    ...calendar,
    dailyGridRef,
    weeklyGridRef,
    cellPopoverRef,
    dayColumns,
    dayRows,
    snapMinutes,
    snapMs,
    pixelsPerHour,
    isTouch,
    events,
    eventsMap,
    selectedEvents,
    weekEvents,
    dayCells,
    detailEvent,
    resizing,
    dragging,
    gridStyle,
    fill,
    page,
    days,
    weeks,
    // Methods
    removeEvent,
    // Event handlers
    onDayNumberClick(day: CalendarDay) {
      emit('day-header-click', day);
      move(day, { view: 'daily' });
    },
    onGridEscapeKeydown() {
      updateState('ESCAPE', days.value[0], 0);
    },
    // Mouse event handlers
    onGridMouseDown(event: MouseEvent) {
      setActiveGrid(event);
      handleEvent('GRID_CURSOR_DOWN', event);
      startMonitoringGridMove();
    },
    onEventMouseDown(event: MouseEvent, evt: Event) {
      setActiveGrid(event);
      handleEvent('EVENT_CURSOR_DOWN', event, evt);
    },
    onEventResizeStartMouseDown(event: MouseEvent, evt: Event) {
      setActiveGrid(event);
      handleEvent('EVENT_RESIZE_START_CURSOR_DOWN', event, evt);
    },
    onEventResizeEndMouseDown(event: MouseEvent, evt: Event) {
      setActiveGrid(event);
      handleEvent('EVENT_RESIZE_END_CURSOR_DOWN', event, evt);
    },
    // Touch event handlers
    onGridTouchStart(event: TouchEvent) {
      setActiveGrid(event);
      handleEvent('GRID_CURSOR_DOWN', event);
    },
    onGridTouchMove(event: TouchEvent) {
      handleEvent('GRID_CURSOR_MOVE', event);
    },
    onGridTouchEnd(event: TouchEvent) {
      handleEvent('GRID_CURSOR_UP', event);
    },
    onEventTouchStart(event: TouchEvent, evt: Event) {
      setActiveGrid(event);
      handleEvent('EVENT_CURSOR_DOWN', event, evt);
    },
    onEventTouchMove(event: TouchEvent, evt: Event) {
      handleEvent('GRID_CURSOR_MOVE', event, evt);
    },
    onEventTouchEnd(event: TouchEvent, evt: Event) {
      handleEvent('GRID_CURSOR_UP', event, evt);
    },
    onEventResizeStartTouchStart(event: TouchEvent, evt: Event) {
      setActiveGrid(event);
      handleEvent('EVENT_RESIZE_START_CURSOR_DOWN', event, evt);
    },
    onEventResizeEndTouchStart(event: TouchEvent, evt: Event) {
      setActiveGrid(event);
      handleEvent('EVENT_RESIZE_END_CURSOR_DOWN', event, evt);
    },
  };
  provide(contextKey, context);

  return context;
}

export interface CalendarGridContext extends CalendarContext {
  snapMinutes: Ref<number>;
  dayRows: ComputedRef<number>;
  dayColumns: ComputedRef<number>;
  snapMs: ComputedRef<number>;
  pixelsPerHour: Ref<number>;
  isTouch: Ref<boolean>;
  events: Ref<Event[]>;
  eventsMap: Ref<Record<any, Event>>;
  selectedEvents: ComputedRef<Event[]>;
  weekEvents: Ref<Event[][]>;
  dayCells: Ref<Cell[][]>;
  detailEvent: Ref<Event | null>;
  resizing: Ref<boolean>;
  dragging: Ref<boolean>;
  gridStyle: ComputedRef<Object>;
  page: ComputedRef<Page>;
  days: ComputedRef<CalendarDay[]>;
  weeks: ComputedRef<CalendarWeek[]>;
  removeEvent: (evt: Event) => void;
  onDayNumberClick: (day: CalendarDay) => void;
  onGridEscapeKeydown: () => void;
  onGridMouseDown: (event: MouseEvent) => void;
  onEventMouseDown: (event: MouseEvent, evt: Event) => void;
  onEventResizeStartMouseDown: (event: MouseEvent, evt: Event) => void;
  onEventResizeEndMouseDown: (event: MouseEvent, evt: Event) => void;
  onGridTouchStart: (event: TouchEvent) => void;
  onGridTouchMove: (event: TouchEvent) => void;
  onGridTouchEnd: (event: TouchEvent) => void;
  onEventTouchStart: (event: TouchEvent, evt: Event) => void;
  onEventTouchMove: (event: TouchEvent, evt: Event) => void;
  onEventTouchEnd: (event: TouchEvent, evt: Event) => void;
  onEventResizeStartTouchStart: (event: TouchEvent, evt: Event) => void;
  onEventResizeEndTouchStart: (event: TouchEvent, evt: Event) => void;
}

export function useCalendarGridContext(): CalendarGridContext {
  const context = inject<CalendarGridContext>(contextKey);
  if (!context) {
    throw new Error(
      'Calendar context missing. Please verify this component is nested within a valid context provider.',
    );
  }
  return context;
}