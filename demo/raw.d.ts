// Vite import suffixes used by the demo: ?raw (a file as text: the seed data) and ?inline (a file as a data URL: the samples).
declare module '*?raw' {
  const text: string;
  export default text;
}
declare module '*?inline' {
  const dataUrl: string;
  export default dataUrl;
}
