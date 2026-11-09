/** Convert painted stroke opacity to a white-edit grayscale mask. */
export function maskAlphaToRgba(input) {
  if(input.length%4)throw Error('遮罩像素无效');
  const output=new Uint8ClampedArray(input.length);
  for(let i=0;i<input.length;i+=4) {const value=input[i+3];output[i]=value;output[i+1]=value;output[i+2]=value;output[i+3]=255;}
  return output;
}
