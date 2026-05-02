export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type SpaceThemeStyle = {
  fill: string;
  fillHover: string;
  fillSelected: string;
  stroke: string;
  labelColor: string;
  icon?: string;
  iconColor?: string;
};

export type AssetThemeStyle = {
  fill: string;
  stroke: string;
  labelColor: string;
  icon?: string;
  iconColor?: string;
  radius: number;
};

export type BuildingMapTheme = {
  canvasBackground: string | null;
  floorBackground: string | null;
  floorBackgroundOpacity: number;
  annotationColor: string;
  spaceDefaults: SpaceThemeStyle;
  spaceStyles: Record<string, Partial<SpaceThemeStyle>>;
  assetDefaults: AssetThemeStyle;
  assetStyles: Record<string, Partial<AssetThemeStyle>>;
};

export type BuildingMapThemeOverrides = DeepPartial<BuildingMapTheme>;
export type BuildingMapThemeDictionary = Record<string, unknown>;

export const DEFAULT_BUILDING_MAP_THEME: BuildingMapTheme = {
  // Null means fully transparent so the map inherits the parent container background.
  canvasBackground: null,
  floorBackground: null,
  floorBackgroundOpacity: 0.22,
  annotationColor: '#1f2937',
  spaceDefaults: {
    fill: '#fdf8ee',
    fillHover: '#f5e8bb',
    fillSelected: '#f9d77a',
    stroke: '#1d1c1a',
    labelColor: '#1d1c1a',
  },
  spaceStyles: {
    room: { icon: 'Room' },
    office: { fill: '#ecf5ff', fillHover: '#dbeeff', fillSelected: '#badcff', icon: 'Office' },
    kitchen: { fill: '#fff3dd', fillHover: '#ffe6c0', fillSelected: '#ffd299', icon: 'Kitchen' },
    bathroom: { fill: '#eef6ff', fillHover: '#deecff', fillSelected: '#c0dbff', icon: 'Bathroom' },
    lobby: { fill: '#f8f3ff', fillHover: '#efe4ff', fillSelected: '#ddc8ff', icon: 'Lobby' },
    foyer: { fill: '#f8f3ff', fillHover: '#efe4ff', fillSelected: '#ddc8ff', icon: 'Foyer' },
    corridor: { fill: '#f3efe8', fillHover: '#e7dece', fillSelected: '#d7c5a7', icon: 'Corridor' },
    hallway: { fill: '#f3efe8', fillHover: '#e7dece', fillSelected: '#d7c5a7', icon: 'Hallway' },
    storage: { fill: '#f5f2e8', fillHover: '#ece5d3', fillSelected: '#d7ccb3', icon: 'Storage' },
    plenum: { fill: '#e0f2fe', fillHover: '#bae6fd', fillSelected: '#7dd3fc', stroke: '#0ea5e9', labelColor: '#0369a1', icon: 'Plenum Zone' },
  },
  assetDefaults: {
    fill: '#0f172a',
    stroke: '#38bdf8',
    labelColor: '#0f172a',
    icon: '•',
    iconColor: '#f8fafc',
    radius: 5,
  },
  assetStyles: {
    door_equipment: { fill: '#111827', stroke: '#374151', icon: 'D', radius: 6 },
    window_equipment: { fill: '#0c4a6e', stroke: '#38bdf8', icon: 'W', radius: 6 },
    sensor: { fill: '#0b3b6f', stroke: '#7dd3fc', icon: 'S', radius: 5.5 },
    equipment: { fill: '#4b5563', stroke: '#cbd5e1', icon: 'E' },
    actuator: { fill: '#7c2d12', stroke: '#fdba74', icon: 'A', radius: 5.5 },
    vav_box: { fill: '#7c3aed', stroke: '#c4b5fd', icon: 'V', radius: 5.5 },
    return_air_grille: { fill: '#065f46', stroke: '#6ee7b7', icon: 'R', radius: 5 },
    air_handling_unit: { fill: '#1d4ed8', stroke: '#93c5fd', icon: 'AH', radius: 8 },
    heat_exchanger: { fill: '#92400e', stroke: '#fcd34d', icon: 'HX', radius: 7 },
    outside_air_damper: { fill: '#065f46', stroke: '#34d399', icon: 'OA', radius: 5.5 },
    return_air_damper: { fill: '#1e3a5f', stroke: '#93c5fd', icon: 'RA', radius: 5.5 },
    exhaust_air_damper: { fill: '#374151', stroke: '#9ca3af', icon: 'EX', radius: 5.5 },
  },
};
