export interface View {
  el: HTMLElement;
  onShow?(): void | Promise<void>;
  onHide?(): void;
}
