/**
 * Unit tests for BoardView's edge-fade overlays (blend the board image's
 * left/right/bottom edges into the app background). These are drawn ON TOP
 * of the image as separate gradient layers, never a mask/crop - so the
 * image itself must always render at full size, untouched, regardless of
 * whether the overlays are present.
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import BoardView from '../BoardView';

describe('BoardView', () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
  });

  it('renders left/right/bottom edge-fade gradients over the board image without cropping it', async () => {
    await act(async () => {
      renderer = ReactTestRenderer.create(<BoardView boardImageBase64="fake-base64-data" />);
    });

    const image = renderer!.root.findByProps({ testID: 'board-image' });
    expect(image.props.source.uri).toContain('fake-base64-data');
    expect(image.props.resizeMode).toBe('contain');

    expect(renderer!.root.findByProps({ testID: 'board-edge-fade-left' })).toBeTruthy();
    expect(renderer!.root.findByProps({ testID: 'board-edge-fade-right' })).toBeTruthy();
    expect(renderer!.root.findByProps({ testID: 'board-edge-fade-bottom' })).toBeTruthy();
  });

  it('does not render edge-fade gradients when there is no board image yet (processing placeholder)', async () => {
    await act(async () => {
      renderer = ReactTestRenderer.create(<BoardView />);
    });

    expect(() => renderer!.root.findByProps({ testID: 'board-image' })).toThrow();
    expect(() => renderer!.root.findByProps({ testID: 'board-edge-fade-left' })).toThrow();
  });
});
